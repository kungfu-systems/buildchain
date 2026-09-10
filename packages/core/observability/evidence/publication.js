import { spawnSync } from "node:child_process";
import { validateObservedEvidenceBundle } from "./bundle.js";
function defaultRunner(args) {
  const result = spawnSync("aws", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || result.error?.message || ""),
  };
}

function jsonOutput(result) {
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return {};
  }
}

function headObject(runner, bucket, key) {
  return runner(["s3api", "head-object", "--bucket", bucket, "--key", key]);
}

function headEvidence(result) {
  if (result.status !== 0) return null;
  const value = jsonOutput(result);
  return {
    sha256: String(value.Metadata?.sha256 || ""),
    snapshotId: String(value.Metadata?.["snapshot-id"] || ""),
    etag: String(value.ETag || "").replaceAll('"', ""),
    versionId: String(value.VersionId || ""),
    contentType: String(value.ContentType || ""),
    cacheControl: String(value.CacheControl || ""),
  };
}

function base64Digest(hex) {
  return Buffer.from(hex, "hex").toString("base64");
}

function putArgs({ bucket, entry, snapshotId, immutable }) {
  const args = [
    "s3api",
    "put-object",
    "--bucket",
    bucket,
    "--key",
    entry.key,
    "--body",
    entry.file,
    "--content-type",
    entry.contentType,
    "--cache-control",
    entry.cacheControl ||
      (immutable
        ? "public,max-age=31536000,immutable"
        : "public,max-age=0,must-revalidate"),
    "--checksum-sha256",
    base64Digest(entry.sha256),
    "--metadata",
    `snapshot-id=${snapshotId},sha256=${entry.sha256}`,
  ];
  if (immutable) args.push("--if-none-match", "*");
  return args;
}

function copySource(bucket, key, versionId) {
  const encoded = `${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return `${encoded}?versionId=${encodeURIComponent(versionId)}`;
}

function rollbackMutableEntries({ commandRunner, bucket, applied }) {
  const operations = [];
  for (const { entry, previous } of [...applied].reverse()) {
    const result = previous
      ? commandRunner([
          "s3api",
          "copy-object",
          "--bucket",
          bucket,
          "--key",
          entry.key,
          "--copy-source",
          copySource(bucket, entry.key, previous.versionId),
          "--metadata-directive",
          "COPY",
        ])
      : commandRunner([
          "s3api",
          "delete-object",
          "--bucket",
          bucket,
          "--key",
          entry.key,
        ]);
    operations.push({
      action: previous ? "restore-previous-version" : "remove-new-projection",
      key: entry.key,
      status: result.status,
    });
    if (result.status !== 0) {
      throw new Error(
        `rollback failed for ${entry.key}: ${result.stderr || result.stdout}`,
      );
    }
  }
  return operations;
}

function assertHeadMatches(head, entry, snapshotId, label) {
  if (!head || head.sha256 !== entry.sha256 || head.snapshotId !== snapshotId) {
    throw new Error(
      `${label} object does not match the admitted snapshot and sha256`,
    );
  }
  if (
    entry.kind.startsWith("projection[") &&
    (head.contentType !== entry.contentType ||
      head.cacheControl !== entry.cacheControl)
  ) {
    throw new Error(
      `${label} object does not match the admitted content type and cache control`,
    );
  }
}

function publishImmutableEvidence({
  commandRunner,
  bucket,
  immutable,
  bundle,
  receipt,
}) {
  const beforeImmutable = headEvidence(
    headObject(commandRunner, bucket, immutable.key),
  );
  if (beforeImmutable) {
    assertHeadMatches(
      beforeImmutable,
      immutable,
      bundle.snapshotId,
      "existing immutable",
    );
    receipt.immutable.status = "reused";
  } else {
    const put = commandRunner(
      putArgs({
        bucket,
        entry: immutable,
        snapshotId: bundle.snapshotId,
        immutable: true,
      }),
    );
    receipt.operations.push({ action: "put-immutable", status: put.status });
    if (put.status !== 0) {
      const concurrent = headEvidence(
        headObject(commandRunner, bucket, immutable.key),
      );
      assertHeadMatches(
        concurrent,
        immutable,
        bundle.snapshotId,
        "concurrent immutable",
      );
      receipt.immutable.status = "reused-concurrent";
    } else {
      receipt.immutable.status = "written";
    }
  }
  const verifiedImmutable = headEvidence(
    headObject(commandRunner, bucket, immutable.key),
  );
  assertHeadMatches(
    verifiedImmutable,
    immutable,
    bundle.snapshotId,
    "verified immutable",
  );
  receipt.immutable.verification = verifiedImmutable;
}

export function publishObservedEvidence(
  options,
  { commandRunner = defaultRunner } = {},
) {
  const bundle = validateObservedEvidenceBundle(options);
  const bucket = String(options.bucket || "").trim();
  if (!bucket) throw new Error("bucket is required");
  const distributionId = String(options.distributionId || "").trim();
  const dryRun = options.dryRun !== false;
  const { immutable, latest, projections } = bundle;
  const receipt = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-observed-evidence-publication-receipt",
    status: dryRun ? "planned" : "applying",
    dryRun,
    snapshotId: bundle.snapshotId,
    observedAt: bundle.manifest.snapshot.observedAt,
    bucket,
    distributionId,
    immutable: {
      key: immutable.key,
      sha256: immutable.sha256,
      status: "planned",
    },
    projections: projections.map((entry) => ({
      key: entry.key,
      sha256: entry.sha256,
      contentType: entry.contentType,
      cacheControl: entry.cacheControl,
      status: "planned",
    })),
    latest: { key: latest.key, sha256: latest.sha256, status: "planned" },
    previousProjections: [],
    previousLatest: null,
    rollback: { status: "not-needed", operations: [] },
    invalidationPaths: bundle.invalidationPaths,
    operations: [],
  };
  if (dryRun) return receipt;

  publishImmutableEvidence({
    commandRunner,
    bucket,
    immutable,
    bundle,
    receipt,
  });

  const mutableEntries = [...projections, latest];
  const previousByKey = new Map(
    mutableEntries.map((entry) => [
      entry.key,
      headEvidence(headObject(commandRunner, bucket, entry.key)),
    ]),
  );
  if (projections.length > 0) {
    for (const [key, previous] of previousByKey) {
      if (previous && !previous.versionId) {
        throw new Error(
          `mutable projection transaction requires bucket versioning before replacing ${key}`,
        );
      }
    }
  }
  receipt.previousProjections = projections.map((entry) => ({
    key: entry.key,
    previous: previousByKey.get(entry.key),
  }));
  receipt.previousLatest = previousByKey.get(latest.key);
  const applied = [];
  try {
    for (const [index, projection] of projections.entries()) {
      const put = commandRunner(
        putArgs({
          bucket,
          entry: projection,
          snapshotId: bundle.snapshotId,
          immutable: false,
        }),
      );
      receipt.operations.push({
        action: "advance-projection",
        key: projection.key,
        status: put.status,
      });
      if (put.status !== 0)
        throw new Error(
          `projection update failed for ${projection.key}: ${put.stderr || put.stdout}`,
        );
      applied.push({
        entry: projection,
        previous: previousByKey.get(projection.key),
      });
      const verified = headEvidence(
        headObject(commandRunner, bucket, projection.key),
      );
      assertHeadMatches(
        verified,
        projection,
        bundle.snapshotId,
        `verified projection ${projection.key}`,
      );
      receipt.projections[index] = {
        ...receipt.projections[index],
        status: "written",
        verification: verified,
      };
    }

    const latestPut = commandRunner(
      putArgs({
        bucket,
        entry: latest,
        snapshotId: bundle.snapshotId,
        immutable: false,
      }),
    );
    receipt.operations.push({
      action: "advance-latest",
      status: latestPut.status,
    });
    if (latestPut.status !== 0)
      throw new Error(
        `latest alias update failed: ${latestPut.stderr || latestPut.stdout}`,
      );
    applied.push({ entry: latest, previous: previousByKey.get(latest.key) });
    const verifiedLatest = headEvidence(
      headObject(commandRunner, bucket, latest.key),
    );
    assertHeadMatches(
      verifiedLatest,
      latest,
      bundle.snapshotId,
      "verified latest",
    );
    receipt.latest = {
      ...receipt.latest,
      status: "written",
      verification: verifiedLatest,
    };

    if (distributionId && bundle.invalidationPaths.length > 0) {
      const invalidation = commandRunner([
        "cloudfront",
        "create-invalidation",
        "--distribution-id",
        distributionId,
        "--paths",
        ...bundle.invalidationPaths,
      ]);
      receipt.operations.push({
        action: "invalidate-cdn",
        status: invalidation.status,
        result: jsonOutput(invalidation),
      });
      if (invalidation.status !== 0)
        throw new Error(
          `CloudFront invalidation failed: ${invalidation.stderr || invalidation.stdout}`,
        );
    }
  } catch (error) {
    if (projections.length > 0 && applied.length > 0) {
      receipt.rollback.status = "applying";
      receipt.rollback.operations = rollbackMutableEntries({
        commandRunner,
        bucket,
        applied,
      });
      receipt.rollback.status = "restored";
    }
    throw error;
  }
  receipt.status = "published";
  receipt.publishedAt = new Date().toISOString();
  return receipt;
}
