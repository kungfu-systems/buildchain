import fs from "node:fs";
import path from "node:path";
const EXACT_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function assertPackageVersion({ pkg, expectedVersion }) {
  if (pkg.private === true) {
    throw new Error("package.json private must be false before npm publish");
  }
  if (!pkg.name || typeof pkg.name !== "string") {
    throw new Error("package.json name must be a non-empty string");
  }
  if (!pkg.version || typeof pkg.version !== "string") {
    throw new Error("package.json version must be a non-empty string");
  }
  if (expectedVersion && pkg.version !== expectedVersion) {
    throw new Error(
      `package.json version must match Buildchain version: package=${pkg.version} buildchain=${expectedVersion}`,
    );
  }
  const exactTag = `v${pkg.version}`;
  if (!EXACT_TAG_PATTERN.test(exactTag)) {
    throw new Error(`unsupported release tag for npm publish: ${exactTag}`);
  }
  return exactTag;
}

export function writeEvidence({ cwd, evidencePath, evidence }) {
  const resolved = path.resolve(cwd, evidencePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(evidence, null, 2)}\n`);
  return resolved;
}

export function npmPublicationEvidence({ publication, pkg, digest }) {
  const expectedVersion = publication.version;
  return {
    schema: 1,
    version: expectedVersion || pkg.version,
    channel: publication.channel || "",
    source_sha: publication.sourceSha || "",
    release_sha: publication.releaseSha || "",
    target_ref: publication.targetRef || "",
    release_material_sha:
      publication.releaseMaterialSha || publication.releaseSha || "",
    publish_tooling_sha:
      publication.publishToolingSha || publication.releaseSha || "",
    artifacts: [
      {
        group: "node",
        kind: "npm",
        name: pkg.name,
        ref: pkg.version,
        digest,
      },
    ],
  };
}
