// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("publish transaction can opt in to rematerialize ephemeral Passport inputs on resume", async () => {
  assert.deepEqual(finalizationRequirements(JSON.stringify([{ group: "node", kind: "npm", name: "@kungfu-tech/buildchain", ref: "4.0.1-alpha.0", digest: "sha512:old", role: "main", required: true }]), true), [{ group: "node", kind: "npm", name: "@kungfu-tech/buildchain", ref_template: "{version}", role: "main", required: true }]);
  const cwd = makeTempWorkspace({
    "package.json": JSON.stringify({
      name: "@kungfu-tech/rematerialization-fixture",
      version: "1.0.0-alpha.0",
    }, null, 2) + "\n",
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "scripts/publish.mjs": `
import fs from "node:fs";
import path from "node:path";

const countPath = path.join(process.cwd(), ".buildchain/publish-count");
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0") + 1;
const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
fs.mkdirSync(path.dirname(countPath), { recursive: true });
fs.writeFileSync(countPath, String(count));
const witnessPath = path.join(process.cwd(), ".buildchain/release-inputs/witness.json");
fs.mkdirSync(path.dirname(witnessPath), { recursive: true });
fs.writeFileSync(witnessPath, JSON.stringify({
  count,
  packageVersion,
  tarballPath: process.env.BUILDCHAIN_SEALED_NPM_TARBALL || "",
  tarballIntegrity: process.env.BUILDCHAIN_SEALED_NPM_INTEGRITY || ""
}, null, 2) + "\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/rematerialization-fixture",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:" + String(count).repeat(64)
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit } = createGitMock();
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/1.0.0/evidence.json");
  const args = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    loadedConfig: loadBuildchainConfig(cwd),
    targetRef: "release/v1/v1.0",
    sourceSha: SHA,
    releaseSha: OTHER_SHA,
    version: "1.0.0",
    exactTag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([{ kind: "npm", name: "@kungfu-tech/rematerialization-fixture", ref_template: "{version}" }]),
    publishEvidencePath: evidencePath,
    transactionStatePath: statePath,
  };

  await runPublishTransaction(args);
  assert.equal(fs.readFileSync(path.join(cwd, ".buildchain/publish-count"), "utf8"), "1");

  fs.rmSync(path.join(cwd, ".buildchain/release-inputs/witness.json"));
  fs.rmSync(statePath);
  fs.rmSync(evidencePath);

  const fakeBin = path.join(cwd, "bin");
  fs.mkdirSync(fakeBin);
  materializeCommandShim(path.join(fakeBin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);
fs.writeFileSync("npm-pack-argv.json", JSON.stringify(args));
const destination = args[args.indexOf("--pack-destination") + 1];
const filename = "kungfu-tech-rematerialization-fixture-1.0.0.tgz";
fs.writeFileSync(path.join(destination, filename), "published exact bytes");
process.stdout.write(JSON.stringify([{ name: "@kungfu-tech/rematerialization-fixture", version: "1.0.0", filename }]));
`);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  let resumed;
  try {
    resumed = await runPublishTransaction({ ...args, publishRematerializeOnResume: true });
  } finally {
    process.env.PATH = previousPath;
  }

  assert.equal(resumed.validation.valid, true);
  assert.equal(fs.readFileSync(path.join(cwd, ".buildchain/publish-count"), "utf8"), "2");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(cwd, ".buildchain/release-inputs/witness.json"), "utf8")).count,
    2,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(cwd, ".buildchain/release-inputs/witness.json"), "utf8")).packageVersion,
    "1.0.0",
  );
  const witness = JSON.parse(fs.readFileSync(path.join(cwd, ".buildchain/release-inputs/witness.json"), "utf8"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "npm-pack-argv.json"), "utf8"))[1], "@kungfu-tech/rematerialization-fixture@1.0.0");
  assert.match(path.basename(witness.tarballPath), /rematerialization-fixture-1\.0\.0\.tgz$/);
  assert.match(witness.tarballIntegrity, /^sha512-/);
  assert.equal(fs.existsSync(witness.tarballPath), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version, "1.0.0-alpha.0");
  assert.equal(
    JSON.parse(fs.readFileSync(resumed.distTagEvidencePath, "utf8")).source,
    "resume-rematerialized:buildchain.toml",
  );
});

test("publish_failed transaction rematerializes the exact npm version before retry", async () => {
  const cwd = makeTempWorkspace({
    "package.json": JSON.stringify({
      name: "@kungfu-tech/publish-failed-rematerialization-fixture",
      version: "1.0.0-alpha.0",
    }, null, 2) + "\n",
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "scripts/publish.mjs": `
import fs from "node:fs";
import path from "node:path";

const countPath = path.join(process.cwd(), ".buildchain/publish-count");
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0") + 1;
fs.mkdirSync(path.dirname(countPath), { recursive: true });
fs.writeFileSync(countPath, String(count));
const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
if (count === 1) {
  fs.writeFileSync("first-publish-witness.txt", packageVersion + "\\n");
  throw new Error("first publish fails");
}
fs.writeFileSync("publish-witness.json", JSON.stringify({
  packageVersion,
  tarballPath: process.env.BUILDCHAIN_SEALED_NPM_TARBALL || ""
}, null, 2) + "\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/publish-failed-rematerialization-fixture",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:" + "7".repeat(64)
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit } = createGitMock();
  const args = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    loadedConfig: loadBuildchainConfig(cwd),
    targetRef: "release/v1/v1.0",
    sourceSha: SHA,
    releaseSha: OTHER_SHA,
    version: "1.0.0",
    exactTag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    publishTransaction: true,
    publishRematerializeOnResume: true,
    publishRequiredArtifactsJson: JSON.stringify([{
      kind: "npm",
      name: "@kungfu-tech/publish-failed-rematerialization-fixture",
      ref_template: "{version}",
    }]),
    publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/1.0.0/evidence.json"),
    transactionStatePath: path.join(cwd, ".buildchain/release-state/1.0.0.json"),
  };

  await assert.rejects(runPublishTransaction(args));
  assert.equal(fs.readFileSync(path.join(cwd, "first-publish-witness.txt"), "utf8"), "1.0.0\n");
  assert.equal(JSON.parse(fs.readFileSync(args.transactionStatePath, "utf8")).state, "publish_failed");

  const resumed = await runPublishTransaction({
    ...args,
    publishRematerializeOnResume: true,
  });
  const witness = JSON.parse(fs.readFileSync(path.join(cwd, "publish-witness.json"), "utf8"));

  assert.equal(resumed.validation.valid, true);
  assert.equal(witness.packageVersion, "1.0.0");
  assert.match(path.basename(witness.tarballPath), /publish-failed-rematerialization-fixture-1\.0\.0\.tgz$/);
  assert.equal(fs.existsSync(witness.tarballPath), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version, "1.0.0-alpha.0");
  assert.equal(
    JSON.parse(fs.readFileSync(resumed.distTagEvidencePath, "utf8")).source,
    "resume-rematerialized:buildchain.toml",
  );
});

test("explicit recovery finalizes an ancestry-bound published transaction without replaying publication", async () => {
  const cwd = makeTempWorkspace({});
  const version = "1.0.0";
  const exactTag = `v${version}`;
  const oldSourceSha = "1".repeat(40);
  const oldReleaseSha = "2".repeat(40);
  const newSourceSha = "3".repeat(40);
  const newReleaseSha = "4".repeat(40);
  const artifact = {
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: version,
    digest: "sha512:published",
  };
  const statePath = path.join(
    cwd,
    ".buildchain/release-state/1.0.0.json",
  );
  const evidencePath = path.join(
    cwd,
    ".buildchain/release-evidence/1.0.0/evidence.json",
  );
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version,
    channel: "release",
    source_sha: oldSourceSha,
    release_sha: oldReleaseSha,
    target_ref: "release/v1/v1.0",
    release_material_sha: oldReleaseSha,
    publish_tooling_sha: oldReleaseSha,
    artifacts: [artifact],
  }, null, 2) + "\n");

  const { octokit, commits } = createGitMock();
  commits.set(oldReleaseSha, {
    sha: oldReleaseSha,
    tree: { sha: `tree-${oldReleaseSha}` },
    parents: [],
  });
  commits.set(newReleaseSha, {
    sha: newReleaseSha,
    tree: { sha: `tree-${newReleaseSha}` },
    parents: [{ sha: oldReleaseSha }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "published-stable-recovery",
      repository: "kungfu-systems/buildchain",
      target_ref: "release/v1/v1.0",
      source_sha: oldSourceSha,
      release_sha: oldReleaseSha,
      release_material_sha: oldReleaseSha,
      publish_tooling_sha: oldReleaseSha,
      version,
      exact_tag: exactTag,
      channel: "release",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0",
      state_path: ".buildchain/release-state/1.0.0.json",
      evidence_path: ".buildchain/release-evidence/1.0.0/evidence.json",
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [artifact],
      evidence: [".buildchain/release-evidence/1.0.0/evidence.json"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath,
  });

  const args = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    targetRef: "release/v1/v1.0",
    sourceSha: newSourceSha,
    releaseSha: newReleaseSha,
    version,
    exactTag,
    channel: "release",
    line: "v1.0",
    publishTransaction: true,
    publishEvidencePath: evidencePath,
    transactionStatePath: statePath,
    publishRequiredArtifactsJson: JSON.stringify([artifact]),
  };

  await assert.rejects(
    runPublishTransaction(args),
    /release transaction identity mismatch/,
  );

  const recovered = await runPublishTransaction({
    ...args,
    explicitOverride: true,
  });

  assert.equal(recovered.transaction.id, "published-stable-recovery");
  assert.equal(recovered.transaction.source_sha, oldSourceSha);
  assert.equal(recovered.transaction.release_sha, oldReleaseSha);
  assert.equal(recovered.transaction.state, "published");
  assert.equal(recovered.validation, undefined);
});

test("publish transaction resumes from durable sealed bytes in a fresh workspace", async () => {
  const version = "0.1.0-alpha.4";
  const sourceCwd = makeTempWorkspace({
    "scripts/publish.mjs": `
import fs from "node:fs";

if (!fs.existsSync(process.env.BUILDCHAIN_SEALED_NPM_TARBALL)) {
  throw new Error("sealed tarball was not provided");
}
process.exitCode = 23;
`,
  });
  const tarballPath = ".buildchain/publication/npm-tarball/paper-0.1.0-alpha.4.tgz";
  const assetPath = "_build/main.pdf";
  const tarballBytes = Buffer.from([
    0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x7f, 0x80, 0xfe, 0x42,
  ]);
  const assetBytes = Buffer.from("%PDF-1.7\nsealed paper\n", "utf8");
  for (const [relativePath, bytes] of [
    [tarballPath, tarballBytes],
    [assetPath, assetBytes],
  ]) {
    const target = path.join(sourceCwd, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const fileEntry = (relativePath) => {
    const bytes = fs.readFileSync(path.join(sourceCwd, relativePath));
    return {
      path: relativePath,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const candidatePayload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
    repository: "kungfu-systems/paper",
    sourceSha: SHA,
    sourceTreeSha: "b".repeat(40),
    runtimeSha: "c".repeat(40),
    manifestDigest: "d".repeat(64),
    passportDigest: "e".repeat(64),
    controllerReceiptDigest: "f".repeat(64),
    files: [fileEntry(tarballPath), fileEntry(assetPath)]
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  const candidate = {
    ...candidatePayload,
    candidateDigest: publicationArtifactCandidateDigest(candidatePayload),
  };
  const manifest = createPublicationSealedBundle({
    candidate,
    packageName: "@kungfu-tech/paper",
    packageVersion: version,
    npmTarballPath: tarballPath,
    npmIntegrity:
      `sha512-${crypto.createHash("sha512").update(tarballBytes).digest("base64")}`,
    releaseAssetPaths: [assetPath],
  });
  const manifestPath = path.join(
    sourceCwd,
    ".buildchain/admitted/sealed-bundle.json",
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const { octokit } = createGitMock();
  const transactionArgs = {
    octokit,
    owner: "kungfu-systems",
    repo: "paper",
    loadedConfig: { config: {} },
    targetRef: "alpha/v0/v0.1",
    sourceSha: SHA,
    releaseSha: OTHER_SHA,
    version,
    exactTag: `v${version}`,
    channel: "alpha",
    line: "v0.1",
    publishTransaction: true,
    publishCommand: "node scripts/publish.mjs",
    publishRequiredArtifactsJson: JSON.stringify([
      { kind: "npm", name: "@kungfu-tech/paper" },
    ]),
    releaseMaterialSha: OTHER_SHA,
    publishToolingSha: OTHER_SHA,
    actor: "codex",
    runId: "first-attempt",
  };

  await assert.rejects(
    runPublishTransaction({
      ...transactionArgs,
      cwd: sourceCwd,
      publishSealedBundleRoot: sourceCwd,
      publishSealedBundleManifest: manifestPath,
    }),
    /Command failed: node scripts\/publish\.mjs/,
  );
  const interruptedState = JSON.parse(
    fs.readFileSync(
      path.join(sourceCwd, `.buildchain/release-state/v${version}.json`),
      "utf8",
    ),
  );
  assert.equal(interruptedState.state, "publish_failed");
  assert.equal(interruptedState.sealed_bundle.root, manifest.root);

  const freshCwd = makeTempWorkspace({
    "scripts/publish.mjs": `
import crypto from "node:crypto";
import fs from "node:fs";

const tarball = fs.readFileSync(process.env.BUILDCHAIN_SEALED_NPM_TARBALL);
const sha256 = crypto.createHash("sha256").update(tarball).digest("hex");
if (sha256 !== process.env.BUILDCHAIN_SEALED_NPM_SHA256) {
  throw new Error("restored sealed tarball digest mismatch");
}
fs.writeFileSync("publish-input.json", JSON.stringify({
  tarballPath: process.env.BUILDCHAIN_SEALED_NPM_TARBALL,
  sha256,
  integrity: process.env.BUILDCHAIN_SEALED_NPM_INTEGRITY
}, null, 2) + "\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/paper",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:" + sha256
  }]
}, null, 2) + "\\n");
`,
  });
  const resumed = await runPublishTransaction({
    ...transactionArgs,
    cwd: freshCwd,
    runId: "fresh-runner-resume",
  });

  const recoveredRoot = path.join(
    freshCwd,
    ".buildchain/recovered-publication",
    version,
  );
  const recoveredTarball = path.join(recoveredRoot, tarballPath);
  const recoveredAsset = path.join(recoveredRoot, assetPath);
  assert.deepEqual(fs.readFileSync(recoveredTarball), tarballBytes);
  assert.deepEqual(fs.readFileSync(recoveredAsset), assetBytes);
  assert.equal(resumed.transaction.state, "published");
  assert.equal(resumed.transaction.publication_state, "package-published");
  assert.equal(resumed.transaction.sealed_bundle.root, manifest.root);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(freshCwd, "publish-input.json"), "utf8"),
    ).tarballPath,
    recoveredTarball,
  );

  const rematerializedCwd = makeTempWorkspace({
    "scripts/publish.mjs": `
import fs from "node:fs";

for (const name of [
  "BUILDCHAIN_SEALED_BUNDLE_ROOT",
  "BUILDCHAIN_SEALED_NPM_TARBALL",
  "BUILDCHAIN_SEALED_NPM_INTEGRITY",
  "BUILDCHAIN_SEALED_NPM_SHA256"
]) {
  if (process.env[name]) {
    throw new Error(name + " must not select restored alpha bytes during rematerialization");
  }
}
fs.writeFileSync("rematerialized-package.txt", process.env.BUILDCHAIN_VERSION + "\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/paper",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:" + "9".repeat(64)
  }]
}, null, 2) + "\\n");
`,
  });
  const rematerialized = await runPublishTransaction({
    ...transactionArgs,
    cwd: rematerializedCwd,
    runId: "fresh-runner-rematerialization",
    publishRematerializeOnResume: true,
  });

  assert.equal(rematerialized.validation.valid, true);
  assert.equal(
    fs.readFileSync(path.join(rematerializedCwd, "rematerialized-package.txt"), "utf8"),
    `${version}\n`,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(rematerialized.distTagEvidencePath, "utf8")).source,
    "resume-rematerialized:workflow-input",
  );
});
