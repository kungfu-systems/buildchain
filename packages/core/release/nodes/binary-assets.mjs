import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";

export function verifyCoordinates(env, execute = command) {
  for (const [directory, key] of [
    [".buildchain/runtime", "RUNTIME_SHA"],
    [".", "SOURCE_SHA"],
  ]) {
    requireValue(
      /^[0-9a-f]{40}$/u.test(env[key] || ""),
      `${key} must be an exact commit`,
    );
    const actual = execute("git", ["-C", directory, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
    requireValue(
      actual === env[key],
      `${key} does not match the checked-out commit`,
    );
  }
}
export function validateBinaryCapability({
  capability,
  manifest,
  tag,
  sourceSha,
  now = Date.now(),
}) {
  const source = String(manifest.release?.sourceSha || "").replace(
    /^sha256:/u,
    "",
  );
  const digest = String(manifest.bundle?.sha256 || "").replace(/^sha256:/u, "");
  const expires = Date.parse(capability.expiresAt);
  const checks = [
    [capability.decision === "allow", "capability decision is not allow"],
    [
      capability.workflowPath ===
        ".github/workflows/.release-binary-assets.yml",
      "capability workflow mismatch",
    ],
    [
      capability.capabilityIds?.includes("github-release"),
      "github-release capability is missing",
    ],
    [
      capability.environment === "buildchain-release-assets",
      "capability environment mismatch",
    ],
    [capability.channel === "release-assets", "capability channel mismatch"],
    [
      capability.version === tag.replace(/^v/u, ""),
      "capability version mismatch",
    ],
    [manifest.release?.tag === tag, "evidence bundle tag mismatch"],
    [
      /^[0-9a-f]{40}$/u.test(source) &&
        source === sourceSha &&
        capability.sourceSha === source,
      "capability source mismatch",
    ],
    [
      /^[0-9a-f]{64}$/u.test(digest) && capability.artifactDigest === digest,
      "capability artifact mismatch",
    ],
    [
      Number.isFinite(expires) && expires > now,
      "capability is stale or has no valid expiry",
    ],
  ];
  const failures = checks
    .filter(([okay]) => !okay)
    .map(([, message]) => message);
  requireValue(failures.length === 0, failures.join("; "));
}
export function admit(env) {
  const capability = JSON.parse(env.BUILDCHAIN_PUBLICATION_CAPABILITY_JSON);
  const manifest = JSON.parse(
    fs.readFileSync(
      ".buildchain/release-passport/buildchain-release-bundle.json",
      "utf8",
    ),
  );
  validateBinaryCapability({
    capability,
    manifest,
    tag: env.RELEASE_TAG,
    sourceSha: env.SOURCE_SHA,
  });
  fs.mkdirSync(".buildchain/publication-authority", { recursive: true });
  fs.writeFileSync(
    ".buildchain/publication-authority/capability.json",
    `${JSON.stringify(capability, null, 2)}\n`,
  );
}
export async function writeChecksums(directory = "dist/binary") {
  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "checksums.txt")
    .map((entry) => entry.name)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  requireValue(files.length > 0, "Binary evidence contains no files");
  const lines = [];
  for (const name of files) {
    requireValue(
      !/[\\\x00-\x1f\x7f]/u.test(name),
      "Binary evidence filename contains an unsupported control or escape character",
    );
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(path.join(directory, name)))
      hash.update(chunk);
    lines.push(`${hash.digest("hex")}  ./${name}\n`);
  }
  const temporary = path.join(
    directory,
    `.buildchain-checksums-${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, lines.join(""), { flag: "wx" });
    fs.renameSync(temporary, path.join(directory, "checksums.txt"));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({
    verify: verifyCoordinates,
    admit,
    checksums: () => writeChecksums(),
  });
