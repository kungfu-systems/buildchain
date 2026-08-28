// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("stable recovery checks the advanced protected head for sealed release material", async () => {
  const requestedSourceSha = "1".repeat(40);
  const protectedMergeSha = "2".repeat(40);
  const sealedMaterialSha = "3".repeat(40);
  const checkedReleaseShas = [];
  const contained = await transactionContainedInRelease(
    {
      octokit: {},
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: requestedSourceSha,
      advancedChannelSha: protectedMergeSha,
      releaseCommitIncludesTransactionHead: async ({
        releaseSha,
        transactionReleaseSha,
      }) => {
        checkedReleaseShas.push(releaseSha);
        return (
          releaseSha === protectedMergeSha &&
          transactionReleaseSha === sealedMaterialSha
        );
      },
    },
    {
      release_sha: sealedMaterialSha,
      release_material_sha: sealedMaterialSha,
    },
  );

  assert.equal(contained, true);
  assert.deepEqual(checkedReleaseShas, [protectedMergeSha]);
});

test("stable recovery reuses the complete transaction publication identity", () => {
  const transaction = {
    state: "complete",
    source_sha: "1".repeat(40),
    release_sha: "2".repeat(40),
    release_material_sha: "3".repeat(40),
    publish_tooling_sha: "4".repeat(40),
  };
  const execution = containedReleaseExecutionIdentity(
    {
      sha: "5".repeat(40),
      advancedPublicationTransaction: transaction,
    },
    {
      containsPublishedMaterial: true,
      currentReleaseTransaction: transaction,
      releaseSha: "6".repeat(40),
    },
  );

  assert.equal(execution.transaction, transaction);
  assert.equal(execution.sourceSha, transaction.source_sha);
  assert.equal(execution.releaseSha, transaction.release_sha);
  assert.equal(execution.releaseMaterialSha, transaction.release_material_sha);
  assert.equal(execution.publishToolingSha, transaction.publish_tooling_sha);
});

test("publish transaction resumes matching alpha durable state refs", async () => {
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
    "package.json": packageManifest("1.0.0-alpha.0"),
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.writeFileSync("unexpected-publish", ""); fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
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
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha0"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
  });
  commits.set(SHA, {
    sha: SHA,
    tree: { sha: `tree-${SHA}` },
    parents: [{ sha: OTHER_SHA }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "non-matching-alpha-1",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: OTHER_SHA,
      release_sha: OTHER_SHA,
      release_material_sha: OTHER_SHA,
      publish_tooling_sha: OTHER_SHA,
      version: "1.0.0-alpha.1",
      exact_tag: "v1.0.0-alpha.1",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-1",
      state_path: "",
      evidence_path: "",
      state: "publishing",
      previous_state: "prepared",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });
  const matchingEvidencePath = path.join(cwd, "durable-alpha-0-evidence.json");
  fs.writeFileSync(
    matchingEvidencePath,
    JSON.stringify(
      {
        schema: 1,
        version: "1.0.0-alpha.0",
        channel: "alpha",
        source_sha: SHA,
        release_sha: OTHER_SHA,
        target_ref: "alpha/v1/v1.0",
        release_material_sha: OTHER_SHA,
        publish_tooling_sha: OTHER_SHA,
        artifacts: [
          {
            kind: "npm",
            name: "@kungfu-tech/buildchain",
            ref: "1.0.0-alpha.0",
            digest: "sha256:alpha0",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "matching-alpha-0",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: OTHER_SHA,
      release_material_sha: OTHER_SHA,
      publish_tooling_sha: OTHER_SHA,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "repair_required",
      previous_state: "publishing",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "publish evidence invalid: artifact coordinate or provenance mismatch: npm:@kungfu-tech/buildchain:ref",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: matchingEvidencePath,
  });
  fs.unlinkSync(matchingEvidencePath);

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true, publishTransactionOverride: true, publishToolingSha: "f".repeat(40),
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha0",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete"); assert.equal(fs.existsSync(path.join(cwd, "unexpected-publish")), false);
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(result.publishTransaction.releaseSha, OTHER_SHA);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), OTHER_SHA);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
  assert.equal(
    fs.existsSync(path.join(cwd, ".buildchain/release-state/v1.0.0-alpha.1.json")),
    false,
  );
});

test("publish transaction finalizes current alpha version-state merge commits", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.0-alpha.0"),
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", mergeSha]]),
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: oldAlphaSha }, { sha: versionHeadSha }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0-alpha.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "alpha-merge-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: oldAlphaSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: statePath,
      evidence_path: "",
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), oldAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
  assert.equal(
    result.updates.some((update) => update.action === "stale-publish-transaction"),
    false,
  );
});

test("publication planning advances past published alpha material when version-state regeneration changes", async () => {
  const previousReleaseSha = "6".repeat(40);
  const promotionMergeSha = "5".repeat(40);
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[[version.files]]
type = "json"
path = "generated.json"
key = "version"
`,
    "package.json": packageManifest("1.0.0-alpha.0"),
    "generated.json": { version: "1.0.0-alpha.0", generated: false },
    "scripts/regenerate.mjs": `
import fs from "node:fs";

const value = JSON.parse(fs.readFileSync("generated.json", "utf8"));
value.generated = true;
fs.writeFileSync("generated.json", JSON.stringify(value, null, 2) + "\\n");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", promotionMergeSha],
      ["heads/dev/v1/v1.0", "7".repeat(40)],
      ["tags/v1.0.0-alpha.0", previousReleaseSha],
      ["tags/v1.0-alpha", promotionMergeSha],
    ]),
  });
  commits.set(promotionMergeSha, {
    sha: promotionMergeSha,
    tree: { sha: `tree-${promotionMergeSha}` },
    parents: [{ sha: previousReleaseSha }, { sha: "8".repeat(40) }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "published-alpha-regeneration",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: previousReleaseSha,
      release_material_sha: previousReleaseSha,
      publish_tooling_sha: previousReleaseSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [{
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha0",
      }],
      evidence: [".buildchain/release-evidence/v1.0.0-alpha.0/evidence.json"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: promotionMergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    dryRun: true,
    publishTransaction: true,
    requireVersionState: true,
    verificationCommand: "node scripts/regenerate.mjs",
    expectedPublicationVersion: "1.0.0-alpha.1",
  });

  assert.deepEqual(
    result.updates.find((update) => update.action === "advanced-published-transaction"),
    {
      tag: "v1.0.0-alpha.0",
      action: "advanced-published-transaction",
      sha: promotionMergeSha,
    },
  );
  assert.equal(
    result.updates.find((update) => update.action === "dry-run-publish-transaction").version,
    "1.0.0-alpha.1",
  );
});
