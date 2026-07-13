import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertTransactionIdentity,
  createReleaseTransaction,
  defaultPublishEvidencePath,
  defaultReleaseStatePath,
  planArtifactPublish,
  planTransactionRecovery,
  readReleaseTransaction,
  resolvePublishArtifactRequirements,
  transitionReleaseTransaction,
  validatePublishEvidence,
  writeReleaseTransaction,
} from "../packages/core/publish-transaction.js";

const SHA = "a".repeat(40);
const RELEASE_SHA = "b".repeat(40);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-transaction-"));
}

function evidence(overrides = {}) {
  return {
    schema: 1,
    version: "1.0.0",
    channel: "release",
    source_sha: SHA,
    release_sha: RELEASE_SHA,
    target_ref: "release/v1/v1.0",
    release_material_sha: RELEASE_SHA,
    publish_tooling_sha: RELEASE_SHA,
    artifacts: [
      {
        group: "node",
        kind: "npm",
        name: "@kungfu-systems/example",
        ref: "1.0.0",
        digest: "sha256:npm",
      },
      {
        group: "image",
        kind: "oci",
        name: "ghcr.io/kungfu-systems/example",
        ref: "1.0.0",
        digest: "sha256:image",
      },
    ],
    ...overrides,
  };
}

test("publish evidence validates common fields and required multi-artifact units", () => {
  const validation = validatePublishEvidence({
    evidence: evidence(),
    version: "1.0.0",
    channel: "release",
    sourceSha: SHA,
    releaseSha: RELEASE_SHA,
    targetRef: "release/v1/v1.0",
    releaseMaterialSha: RELEASE_SHA,
    publishToolingSha: RELEASE_SHA,
    requiredArtifacts: [
      { kind: "npm", name: "@kungfu-systems/example", ref: "1.0.0", digest: "sha256:npm" },
      { kind: "oci", name: "ghcr.io/kungfu-systems/example", ref: "1.0.0", digest: "sha256:image" },
    ],
  });
  assert.equal(validation.valid, true);
  assert.equal(validation.evidence.artifacts.length, 2);
});

test("publish evidence fails closed on material drift and missing required artifacts", () => {
  const validation = validatePublishEvidence({
    evidence: evidence({ release_material_sha: "c".repeat(40), artifacts: [] }),
    version: "1.0.0",
    channel: "release",
    sourceSha: SHA,
    releaseSha: RELEASE_SHA,
    targetRef: "release/v1/v1.0",
    releaseMaterialSha: RELEASE_SHA,
    requiredArtifacts: [
      { kind: "npm", name: "@kungfu-systems/example", ref: "1.0.0", digest: "sha256:npm" },
    ],
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /release_material_sha mismatch/);
  assert.match(validation.errors.join("\n"), /required artifact missing/);
});

test("artifact publish plan resumes missing artifacts and requires repair on conflicts", () => {
  const plan = planArtifactPublish({
    requiredArtifacts: [
      { kind: "npm", name: "pkg-a", ref: "1.0.0", digest: "sha256:a" },
      { kind: "oci", name: "image-a", ref: "1.0.0", digest: "sha256:b" },
      { kind: "binary", name: "darwin-arm64", ref: "1.0.0", digest: "sha256:c" },
    ],
    existingArtifacts: [
      { kind: "npm", name: "pkg-a", ref: "1.0.0", digest: "sha256:a" },
      { kind: "oci", name: "image-a", ref: "1.0.0", digest: "sha256:wrong" },
    ],
  });
  assert.deepEqual(plan.accepted.map((artifact) => artifact.name), ["pkg-a"]);
  assert.deepEqual(plan.publish.map((artifact) => artifact.name), ["darwin-arm64"]);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.repairRequired, true);
});

test("post-publish requirements resolve the exact release ref without inventing a digest", () => {
  const requiredArtifacts = resolvePublishArtifactRequirements([
    { group: "image", kind: "oci", name: "ghcr.io/kungfu-systems/base-linux" },
    { group: "image", kind: "oci", name: "ghcr.io/kungfu-systems/node24-pnpm" },
  ], {
    version: "1.2.0-alpha.3",
    targetRef: "alpha/v1/v1.2",
    sourceSha: SHA,
    releaseMaterialSha: RELEASE_SHA,
  });

  assert.deepEqual(requiredArtifacts.map(({ name, ref, digest }) => ({ name, ref, digest })), [
    { name: "ghcr.io/kungfu-systems/base-linux", ref: "1.2.0-alpha.3", digest: "" },
    { name: "ghcr.io/kungfu-systems/node24-pnpm", ref: "1.2.0-alpha.3", digest: "" },
  ]);
  const validation = validatePublishEvidence({
    evidence: evidence({
      version: "1.2.0-alpha.3",
      channel: "alpha",
      target_ref: "alpha/v1/v1.2",
      artifacts: requiredArtifacts.map((artifact, index) => ({
        ...artifact,
        digest: `sha256:image-${index}`,
      })),
    }),
    version: "1.2.0-alpha.3",
    channel: "alpha",
    sourceSha: SHA,
    releaseSha: RELEASE_SHA,
    targetRef: "alpha/v1/v1.2",
    releaseMaterialSha: RELEASE_SHA,
    requiredArtifacts,
  });

  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("mixed OCI family provenance is preserved and validated fail closed", () => {
  const names = ["base-linux", "node24-pnpm", "latex-pdf-builder", "native-linux-x64", "kungfu-verify"];
  const requirements = resolvePublishArtifactRequirements(names.map((name, index) => ({
    group: "image",
    kind: "oci",
    name: `ghcr.io/kungfu-systems/${name}`,
    action: index === 2 ? "built" : "reused",
    platform: "linux/amd64",
    contract_major: 1,
    ...(index > 0 ? { parent_digest: `sha256:parent-${index}` } : {}),
    ...(index === 2 ? {} : {
      content: {
        version: "1.1.9",
        ref: "1.1.9",
        source_sha: "c".repeat(40),
        material_sha: "d".repeat(40),
      },
    }),
  })), {
    version: "1.2.0-alpha.3",
    targetRef: "alpha/v1/v1.2",
    sourceSha: SHA,
    releaseMaterialSha: RELEASE_SHA,
  });
  const artifacts = requirements.map((artifact, index) => {
    const digest = `sha256:image-${index}`;
    return {
      ...artifact,
      digest,
      verification: {
        public_manifest: true,
        ref: artifact.ref,
        digest,
        platform: artifact.platform,
        contract_major: artifact.contract_major,
        ...(artifact.parent_digest ? { parent_digest: artifact.parent_digest } : {}),
        evidence: `registry-inspect-${index}.json`,
        smoke: {
          policy: "manifest-contract",
          passed: true,
          evidence: `smoke-${index}.json`,
        },
      },
    };
  });
  const validation = validatePublishEvidence({
    evidence: evidence({
      version: "1.2.0-alpha.3",
      channel: "alpha",
      target_ref: "alpha/v1/v1.2",
      artifacts,
    }),
    version: "1.2.0-alpha.3",
    channel: "alpha",
    sourceSha: SHA,
    releaseSha: RELEASE_SHA,
    targetRef: "alpha/v1/v1.2",
    releaseMaterialSha: RELEASE_SHA,
    requiredArtifacts: requirements,
  });

  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.deepEqual(validation.evidence.artifacts.map((artifact) => artifact.action), [
    "reused", "reused", "built", "reused", "reused",
  ]);
  assert.equal(validation.evidence.artifacts[0].content.material_sha, "d".repeat(40));

  const drifted = structuredClone(artifacts);
  drifted[0].verification.digest = "sha256:registry-drift";
  assert.throws(
    () => validatePublishEvidence({
      evidence: evidence({
        version: "1.2.0-alpha.3",
        channel: "alpha",
        target_ref: "alpha/v1/v1.2",
        artifacts: drifted,
      }),
      version: "1.2.0-alpha.3",
      channel: "alpha",
      sourceSha: SHA,
      releaseSha: RELEASE_SHA,
      targetRef: "alpha/v1/v1.2",
      releaseMaterialSha: RELEASE_SHA,
      requiredArtifacts: requirements,
    }),
    /verification\.digest mismatch/,
  );
});

test("transaction recovery blocks repair and abandoned states unless override is explicit", () => {
  const record = transitionReleaseTransaction(
    createReleaseTransaction({
      repository: "kungfu-systems/buildchain",
      version: "1.0.0",
      exactTag: "v1.0.0",
      channel: "release",
      sourceSha: SHA,
      targetRef: "release/v1/v1.0",
      releaseSha: RELEASE_SHA,
    }),
    "publishing",
  );
  const repair = transitionReleaseTransaction(record, "repair_required", {
    failure: "artifact digest mismatch",
  });
  assert.deepEqual(planTransactionRecovery({ transaction: repair }), {
    action: "blocked",
    blocked: true,
    reason: "transaction requires explicit repair",
  });
  assert.equal(
    planTransactionRecovery({ transaction: repair, explicitOverride: true }).action,
    "publish",
  );

  const abandoned = transitionReleaseTransaction(repair, "abandoned", {
    supersededBy: "v1.0.1",
  });
  assert.equal(planTransactionRecovery({ transaction: abandoned }).blocked, true);
  assert.equal(
    planTransactionRecovery({ transaction: abandoned, explicitOverride: true }).blocked,
    false,
  );
});

test("transaction identity allows tooling drift but fails closed on material drift", () => {
  const record = createReleaseTransaction({
    repository: "kungfu-systems/buildchain",
    version: "1.0.0",
    exactTag: "v1.0.0",
    channel: "release",
    sourceSha: SHA,
    targetRef: "release/v1/v1.0",
    releaseSha: RELEASE_SHA,
    releaseMaterialSha: RELEASE_SHA,
    publishToolingSha: "c".repeat(40),
  });

  assert.doesNotThrow(() =>
    assertTransactionIdentity(record, {
      repository: "kungfu-systems/buildchain",
      version: "1.0.0",
      sourceSha: SHA,
      targetRef: "release/v1/v1.0",
      releaseMaterialSha: RELEASE_SHA,
      publishToolingSha: "d".repeat(40),
    }, { allowToolingDrift: true }),
  );
  assert.throws(
    () =>
      assertTransactionIdentity(record, {
        repository: "kungfu-systems/buildchain",
        version: "1.0.0",
        sourceSha: SHA,
        targetRef: "release/v1/v1.0",
        releaseMaterialSha: "e".repeat(40),
        publishToolingSha: "d".repeat(40),
      }, { allowToolingDrift: true }),
    /release_material_sha mismatch/,
  );
  assert.throws(
    () =>
      assertTransactionIdentity(record, {
        repository: "kungfu-systems/buildchain",
        version: "1.0.0",
        sourceSha: SHA,
        targetRef: "release/v1/v1.0",
        releaseMaterialSha: RELEASE_SHA,
        publishToolingSha: "d".repeat(40),
      }, { allowToolingDrift: false }),
    /publish_tooling_sha mismatch/,
  );
});

test("release-transaction CLI can inspect, recover, and finalize a valid local transaction", () => {
  const cwd = tempDir();
  const statePath = defaultReleaseStatePath("v1.0.0", cwd);
  const evidencePath = defaultPublishEvidencePath("v1.0.0", cwd);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence(), null, 2)}\n`);
  const record = transitionReleaseTransaction(
    createReleaseTransaction({
      repository: "kungfu-systems/buildchain",
      version: "1.0.0",
      exactTag: "v1.0.0",
      channel: "release",
      sourceSha: SHA,
      targetRef: "release/v1/v1.0",
      releaseSha: RELEASE_SHA,
      statePath,
      evidencePath,
    }),
    "publishing",
  );
  writeReleaseTransaction(statePath, transitionReleaseTransaction(record, "published"));

  const cli = path.join(process.cwd(), "scripts/release-transaction.mjs");
  const recover = spawnSync(process.execPath, [
    cli,
    "recover",
    "--version",
    "v1.0.0",
    "--state-path",
    statePath,
    "--evidence-path",
    evidencePath,
  ], { cwd, encoding: "utf8" });
  assert.equal(recover.status, 0, recover.stderr);
  assert.match(recover.stdout, /"action": "finalize"/);

  const finalize = spawnSync(process.execPath, [
    cli,
    "finalize",
    "--version",
    "v1.0.0",
    "--state-path",
    statePath,
    "--evidence-path",
    evidencePath,
  ], { cwd, encoding: "utf8" });
  assert.equal(finalize.status, 0, finalize.stderr);
  assert.equal(readReleaseTransaction(statePath).state, "complete");
});

test("publish-transaction-shaped fixture writes valid generic evidence", () => {
  const fixture = path.join(process.cwd(), "fixtures/publish-transaction-shaped");
  const cwd = tempDir();
  fs.cpSync(fixture, cwd, { recursive: true });
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json");
  const run = spawnSync(process.execPath, ["scripts/publish.mjs"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      BUILDCHAIN_VERSION: "1.0.0",
      BUILDCHAIN_CHANNEL: "release",
      BUILDCHAIN_SOURCE_SHA: SHA,
      BUILDCHAIN_RELEASE_SHA: RELEASE_SHA,
      BUILDCHAIN_RELEASE_MATERIAL_SHA: RELEASE_SHA,
      BUILDCHAIN_PUBLISH_TOOLING_SHA: "c".repeat(40),
      BUILDCHAIN_TARGET_REF: "release/v1/v1.0",
      BUILDCHAIN_EVIDENCE_DIR: path.dirname(evidencePath),
      BUILDCHAIN_PUBLISH_EVIDENCE: evidencePath,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const validation = validatePublishEvidence({
    evidence: JSON.parse(fs.readFileSync(evidencePath, "utf8")),
    version: "1.0.0",
    channel: "release",
    sourceSha: SHA,
    releaseSha: RELEASE_SHA,
    targetRef: "release/v1/v1.0",
    releaseMaterialSha: RELEASE_SHA,
    publishToolingSha: "c".repeat(40),
    requiredArtifacts: [
      {
        kind: "npm",
        name: "@kungfu-systems/publish-transaction-shaped",
        ref: "1.0.0",
        digest: JSON.parse(fs.readFileSync(evidencePath, "utf8")).artifacts[0].digest,
      },
      {
        kind: "oci",
        name: "ghcr.io/kungfu-systems/publish-transaction-shaped",
        ref: "1.0.0",
        digest: JSON.parse(fs.readFileSync(evidencePath, "utf8")).artifacts[1].digest,
      },
      {
        kind: "archive",
        name: "publish-transaction-shaped-darwin-arm64",
        ref: "1.0.0",
        digest: JSON.parse(fs.readFileSync(evidencePath, "utf8")).artifacts[2].digest,
      },
    ],
  });
  assert.equal(validation.valid, true);
});

test("npm publish transaction writes Buildchain evidence without real publish in dry-run mode", () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "buildchain-npm-transaction-fixture",
    version: "1.2.3-alpha.0",
    private: false,
    license: "Apache-2.0",
  }, null, 2));
  fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/1.2.3-alpha.0/evidence.json");
  const run = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts/npm-publish-transaction.mjs"),
    "--cwd",
    cwd,
    "--dry-run-publish",
    "--skip-registry-lookup",
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      BUILDCHAIN_VERSION: "1.2.3-alpha.0",
      BUILDCHAIN_CHANNEL: "alpha",
      BUILDCHAIN_SOURCE_SHA: SHA,
      BUILDCHAIN_RELEASE_SHA: RELEASE_SHA,
      BUILDCHAIN_RELEASE_MATERIAL_SHA: RELEASE_SHA,
      BUILDCHAIN_PUBLISH_TOOLING_SHA: RELEASE_SHA,
      BUILDCHAIN_TARGET_REF: "alpha/v1/v1.2",
      BUILDCHAIN_EVIDENCE_DIR: path.dirname(evidencePath),
      BUILDCHAIN_PUBLISH_EVIDENCE: evidencePath,
    },
  });

  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.publishAction, "dry-run");
  assert.equal(output.distTag, "alpha");
  assert.ok(output.pack.integrity);
  const writtenEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(writtenEvidence.artifacts[0].kind, "npm");
  assert.equal(writtenEvidence.artifacts[0].name, "buildchain-npm-transaction-fixture");
  assert.equal(writtenEvidence.artifacts[0].ref, "1.2.3-alpha.0");
  assert.equal(writtenEvidence.artifacts[0].digest, output.pack.integrity);
  const validation = validatePublishEvidence({
    evidence: writtenEvidence,
    version: "1.2.3-alpha.0",
    channel: "alpha",
    sourceSha: SHA,
    releaseSha: RELEASE_SHA,
    targetRef: "alpha/v1/v1.2",
    releaseMaterialSha: RELEASE_SHA,
    publishToolingSha: RELEASE_SHA,
    requiredArtifacts: [{
      kind: "npm",
      name: "buildchain-npm-transaction-fixture",
      ref: "1.2.3-alpha.0",
      digest: output.pack.integrity,
    }],
  });
  assert.equal(validation.valid, true);
});

test("npm publish transaction honors explicit dist tag for libnode-style final versions", () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "@kungfu-tech/libnode-fixture",
    version: "22.22.3-kf.3",
    private: false,
    license: "Apache-2.0",
  }, null, 2));
  fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/22.22.3-kf.3/evidence.json");
  const run = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts/npm-publish-transaction.mjs"),
    "--cwd",
    cwd,
    "--dry-run-publish",
    "--skip-registry-lookup",
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      BUILDCHAIN_VERSION: "22.22.3-kf.3",
      BUILDCHAIN_CHANNEL: "release",
      BUILDCHAIN_SOURCE_SHA: SHA,
      BUILDCHAIN_RELEASE_SHA: RELEASE_SHA,
      BUILDCHAIN_RELEASE_MATERIAL_SHA: RELEASE_SHA,
      BUILDCHAIN_PUBLISH_TOOLING_SHA: RELEASE_SHA,
      BUILDCHAIN_TARGET_REF: "release/v22/v22.22",
      BUILDCHAIN_EVIDENCE_DIR: path.dirname(evidencePath),
      BUILDCHAIN_PUBLISH_EVIDENCE: evidencePath,
      BUILDCHAIN_NPM_DIST_TAG: "latest",
    },
  });

  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.distTag, "latest");
  assert.equal(output.package.version, "22.22.3-kf.3");
});

test("npm publish transaction fails closed on non-404 registry lookup errors", () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "buildchain-npm-transaction-fixture",
    version: "1.2.3",
    private: false,
    license: "Apache-2.0",
  }, null, 2));
  fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
  const fakeBin = path.join(cwd, "bin");
  fs.mkdirSync(fakeBin);
  const fakeNpm = path.join(fakeBin, "npm");
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pack") {
  process.stdout.write(JSON.stringify([{
    name: "buildchain-npm-transaction-fixture",
    version: "1.2.3",
    filename: "fixture.tgz",
    integrity: "sha512-fixture",
    shasum: "fixture",
    files: [{ path: "package.json" }]
  }]));
  process.exit(0);
}
if (args[0] === "view") {
  process.stderr.write("npm ERR! code EAI_AGAIN\\n");
  process.exit(1);
}
process.stderr.write("unexpected npm command: " + args.join(" ") + "\\n");
process.exit(2);
`);
  fs.chmodSync(fakeNpm, 0o755);
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/1.2.3/evidence.json");
  const run = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts/npm-publish-transaction.mjs"),
    "--cwd",
    cwd,
    "--dry-run-publish",
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      BUILDCHAIN_VERSION: "1.2.3",
      BUILDCHAIN_CHANNEL: "release",
      BUILDCHAIN_SOURCE_SHA: SHA,
      BUILDCHAIN_RELEASE_SHA: RELEASE_SHA,
      BUILDCHAIN_RELEASE_MATERIAL_SHA: RELEASE_SHA,
      BUILDCHAIN_PUBLISH_TOOLING_SHA: RELEASE_SHA,
      BUILDCHAIN_TARGET_REF: "release/v1/v1.2",
      BUILDCHAIN_EVIDENCE_DIR: path.dirname(evidencePath),
      BUILDCHAIN_PUBLISH_EVIDENCE: evidencePath,
    },
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /npm view buildchain-npm-transaction-fixture@1\.2\.3 failed/);
  assert.equal(fs.existsSync(evidencePath), false);
});
