// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, recordGitHubReleaseTransactionCompletion, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, reuseCompleteGitHubReleaseEvidence, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("OCI provenance conflicts enter repair_required before alpha refs move", async () => {
  const cwd = makeTempWorkspace({
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
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

const [required] = JSON.parse(process.env.BUILDCHAIN_REQUIRED_ARTIFACTS);
const digest = "sha256:reused";
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
    ...required,
    digest,
    verification: {
      public_manifest: true,
      ref: required.ref,
      digest: "sha256:registry-conflict",
      platform: required.platform,
      contract_major: required.contract_major,
      evidence: "registry-inspect.json",
      smoke: { policy: "manifest-contract", passed: true, evidence: "smoke.json" }
    }
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
  });

  await assert.rejects(
    () => promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      cwd,
      publishTransaction: true,
      publishRequiredArtifactsJson: JSON.stringify([{
        group: "image",
        kind: "oci",
        name: "ghcr.io/kungfu-systems/base-linux",
        action: "reused",
        platform: "linux/amd64",
        contract_major: 1,
        content: {
          version: "0.9.9",
          ref: "0.9.9",
          source_sha: "c".repeat(40),
          material_sha: "d".repeat(40),
        },
      }]),
    }),
    /verification\.digest mismatch/,
  );

  const state = JSON.parse(fs.readFileSync(
    path.join(cwd, ".buildchain/release-state/v1.0.0-alpha.0.json"),
    "utf8",
  ));
  assert.equal(state.state, "repair_required");
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), SHA);
});

test("release final-version trusted publishing runs without npm token auth", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

const requiredArtifacts = JSON.parse(process.env.BUILDCHAIN_REQUIRED_ARTIFACTS);
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync("publish-env.json", JSON.stringify({
  mode: process.env.BUILDCHAIN_PUBLISH_MODE,
  auth: process.env.BUILDCHAIN_PUBLISH_AUTH,
  distTag: process.env.BUILDCHAIN_NPM_DIST_TAG,
  tokenConfigured: Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || process.env.npm_config__authToken),
  requiredArtifacts
}, null, 2) + "\\n");
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: requiredArtifacts.map((artifact) => ({
    ...artifact,
    digest: "sha256:release-image"
  }))
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, blobs, trees, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    NPM_TOKEN: process.env.NPM_TOKEN,
    npm_config__authToken: process.env.npm_config__authToken,
  };
  delete process.env.NODE_AUTH_TOKEN;
  delete process.env.NPM_TOKEN;
  delete process.env.npm_config__authToken;
  try {
    const result = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      cwd,
      publishTransaction: true,
      releasePassportImpactJson: productionImpactJson(),
      publishRequiredArtifactsJson: JSON.stringify([
        {
          kind: "oci",
          name: "ghcr.io/kungfu-systems/build-images/base-linux",
          ref_template: "v{version}",
        },
      ]),
    });

    assert.equal(result.publishTransaction.state, "complete");
    assert.equal(refs.has("tags/v1.0.0"), true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(cwd, "publish-env.json"), "utf8")),
      {
        mode: "publish-final-version",
        auth: "trusted-publishing",
        distTag: "latest",
        tokenConfigured: false,
        requiredArtifacts: [{
          group: "",
          kind: "oci",
          name: "ghcr.io/kungfu-systems/build-images/base-linux",
          ref: "v1.0.0",
          digest: "",
          role: "",
          required: true,
        }],
      },
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("publish transaction expands ref templates after skipping occupied alpha versions", async () => {
  const cwd = makeTempWorkspace({
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
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

const [required] = JSON.parse(process.env.BUILDCHAIN_REQUIRED_ARTIFACTS);
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync("required-artifacts.json", process.env.BUILDCHAIN_REQUIRED_ARTIFACTS + "\\n");
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
    ...required,
    digest: "sha256:alpha1"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
      ["heads/buildchain/release-state/1-0-0-alpha-0", OTHER_SHA],
    ]),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "oci",
        name: "ghcr.io/kungfu-systems/build-images/base-linux",
        ref_template: "v{version}",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.1");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-1");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), OTHER_SHA);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), true);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-1"), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(cwd, "required-artifacts.json"), "utf8")),
    [{
      group: "",
      kind: "oci",
      name: "ghcr.io/kungfu-systems/build-images/base-linux",
      ref: "v1.0.0-alpha.1",
      digest: "",
      role: "",
      required: true,
    }],
  );
  const transaction = JSON.parse(fs.readFileSync(
    path.join(cwd, result.publishTransaction.statePath),
    "utf8",
  ));
  assert.equal(transaction.state, "complete");
  assert.equal(transaction.artifacts[0].ref, "v1.0.0-alpha.1");
  const completion = await recordGitHubReleaseTransactionCompletion({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    statePath: result.publishTransaction.statePath,
    evidencePath: result.publishTransaction.evidencePath,
    release: {
      action: "created",
      tag: "v1.0.0-alpha.1",
      url: "https://github.com/kungfu-systems/buildchain/releases/tag/v1.0.0-alpha.1",
      assetCount: 1,
    },
  });
  assert.equal(completion.transaction.publication_state, "alpha-complete");
  const passport = JSON.parse(fs.readFileSync(
    path.join(cwd, result.publishTransaction.releasePassportPath),
    "utf8",
  ));
  assert.equal(
    passport.artifacts.find((artifact) => artifact.kind === "oci")?.ref,
    "v1.0.0-alpha.1",
  );
});
