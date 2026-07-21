import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishObservedEvidence, validateObservedEvidenceBundle } from "../scripts/observed-evidence.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observed-evidence-"));
  const snapshotId = "snapshot-2026-07-21T00:00:00Z";
  const document = `${JSON.stringify({ snapshotId, value: 1 })}\n`;
  fs.mkdirSync(path.join(root, "snapshots"));
  fs.writeFileSync(path.join(root, "snapshots", `${snapshotId}.json`), document);
  fs.writeFileSync(path.join(root, "latest.json"), document);
  const digest = crypto.createHash("sha256").update(document).digest("hex");
  const manifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-observed-evidence-bundle",
    snapshot: { id: snapshotId, observedAt: "2026-07-21T00:00:00Z" },
    publication: {
      immutable: { source: `snapshots/${snapshotId}.json`, key: `dogfood-evidence/snapshots/${snapshotId}.json`, sha256: digest },
      latest: { source: "latest.json", key: "dogfood-evidence.json", sha256: digest },
      invalidationPaths: ["/dogfood-evidence.json", "/dogfood/*"],
    },
  };
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifestPath, snapshotId, digest };
}

test("observed evidence validates exact immutable and latest digests", () => {
  const value = fixture();
  const result = validateObservedEvidenceBundle({ manifestPath: value.manifestPath, artifactRoot: value.root });
  assert.equal(result.snapshotId, value.snapshotId);
  fs.appendFileSync(path.join(value.root, "latest.json"), "drift");
  assert.throws(() => validateObservedEvidenceBundle({ manifestPath: value.manifestPath, artifactRoot: value.root }), /does not match/);
});

test("publisher verifies immutable before atomically advancing latest", () => {
  const value = fixture();
  const objects = new Map();
  const actions = [];
  const runner = (args) => {
    const action = args.slice(0, 2).join(" ");
    actions.push(action);
    const key = args[args.indexOf("--key") + 1];
    if (action === "s3api head-object") {
      const object = objects.get(key);
      return object ? { status: 0, stdout: JSON.stringify({ Metadata: object.metadata, ETag: '"etag"' }), stderr: "" } : { status: 254, stdout: "", stderr: "not found" };
    }
    if (action === "s3api put-object") {
      const metadata = Object.fromEntries(args[args.indexOf("--metadata") + 1].split(",").map((entry) => entry.split("=")));
      objects.set(key, { metadata });
      return { status: 0, stdout: "{}", stderr: "" };
    }
    if (action === "cloudfront create-invalidation") return { status: 0, stdout: '{"Invalidation":{"Id":"I1"}}', stderr: "" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const result = publishObservedEvidence({ manifestPath: value.manifestPath, artifactRoot: value.root, bucket: "bucket", distributionId: "DIST", dryRun: false }, { commandRunner: runner });
  assert.equal(result.status, "published");
  assert.equal(result.immutable.status, "written");
  assert.equal(result.latest.status, "written");
  assert.ok(actions.indexOf("s3api put-object") < actions.lastIndexOf("s3api put-object"));
  assert.equal(objects.get("dogfood-evidence.json").metadata["snapshot-id"], value.snapshotId);
});

test("publisher never replaces a conflicting immutable snapshot", () => {
  const value = fixture();
  const runner = (args) => args[1] === "head-object"
    ? { status: 0, stdout: JSON.stringify({ Metadata: { sha256: "0".repeat(64), "snapshot-id": value.snapshotId } }), stderr: "" }
    : { status: 1, stdout: "", stderr: "unexpected write" };
  assert.throws(() => publishObservedEvidence({ manifestPath: value.manifestPath, artifactRoot: value.root, bucket: "bucket", dryRun: false }, { commandRunner: runner }), /existing immutable object/);
});
