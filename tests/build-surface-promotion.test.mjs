import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_ARTIFACT_NAME_TEMPLATE,
  LINUX_CONTAINER_PRESETS,
  createResolvedReleaseManifest,
  parsePublishSourceRef,
  parseExpectedArtifactsJson,
  resolvePublishChannelTargetRef,
  verifyPublishChannelPrLineage,
  planPackageSetPublish,
  resolveArtifactContract,
  resolvePublishGate,
  resolvePublishSourceLock,
  resolveRunnerMatrix,
  verifyPublishChannelRef,
  verifyPublishSourceLock,
} from "../scripts/build-contract-core.mjs";
import { aggregateBuildSummaryCli } from "../scripts/aggregate-build-summary.mjs";
import { aggregateDiagnosticsSummaryCli } from "../scripts/aggregate-diagnostics-summary.mjs";
import {
  cleanupRelayArtifacts,
  downloadRelayArtifacts,
  uploadRelayArtifacts,
} from "../scripts/artifact-relay-s3.mjs";
import {
  RELEASE_REVIEW_MARKER,
  renderReleaseReviewComment,
  resolveReleaseReviewState,
} from "../scripts/web-surface-release-pr-review.mjs";
import {
  compactProductionReleasePrSummary,
  createProductionReleasePrHandoff,
  openProductionReleasePr,
  recordProductionReleasePrOutcome,
  releaseBranchName,
  readStagingReleasePrSummary,
  renderProductionReleasePrBody,
  webSurfaceProductionReleasePrCli,
} from "../scripts/web-surface-production-release-pr.mjs";
import { compactWebSurfaceApplyResult } from "../scripts/web-surface.mjs";
import {
  RELEASE_FEEDBACK_MARKERS,
  createWebSurfaceReleasePassport,
  normalizeActorIdentity,
  renderWebSurfaceReleaseFeedbackComment,
} from "../scripts/web-surface-release-feedback.mjs";
import {
  currentGitHubRefSha,
  resolvePublishSourceRefSha,
} from "../scripts/publish-source-ref-resolver.mjs";
import {
  RELEASE_CANDIDATE_PASSPORT_CONTRACT,
  createReleaseCandidatePassport,
} from "../packages/core/release-candidate.js";
import { validatePromotionReleaseCandidate } from "../actions/promote-buildchain-ref/lib.js";
import { resolveReleaseCandidateArtifacts } from "../scripts/release-candidate-resolver.mjs";
import {
  classifyBuildchainRuntimeRef,
  normalizeRequestedRuntimeRef,
  resolveRuntimeSelection,
  validateRuntimeOverrideTrust,
} from "../scripts/runtime-ref-core.mjs";
import { resolvePublishSourceCli } from "../scripts/resolve-publish-source.mjs";
import { evaluateBuildchainContractLock } from "../packages/core/buildchain-contract.js";
import {
  canAdmitSelfDogfoodLockEvaluation,
  contractForSelfDogfoodEvaluation,
  resolveSelfDogfoodMajor,
} from "../packages/core/self-dogfood-version.js";
import {
  runLifecycle,
  verifyBuildLifecycleCompilerCacheActivity,
} from "../scripts/run-lifecycle-core.mjs";
import { verifyPublishChannelRefCli } from "../scripts/verify-publish-channel-ref.mjs";
import { verifyPublishSourceLockCli } from "../scripts/verify-publish-source-lock.mjs";
import {
  discoverConfiguredVersionStateFiles,
  loadBuildchainConfig,
  updateConfiguredVersionStateContents,
  validateBuildchainConfig,
} from "../packages/core/buildchain-config.js";
import {
  BUILDCHAIN_DIAGNOSTICS_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
} from "../packages/core/diagnostics.js";
import { materializeSelfReleaseCandidateVersion } from "../scripts/materialize-self-release-candidate-version.mjs";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

test("promote action exposes generic publish source-lock gate", () => {
  const action = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/action.yml"),
    "utf8",
  );
  const implementation = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/index.js"),
    "utf8",
  );

  assert.match(action, /require-publish-source-lock:/);
  assert.match(action, /publish-source-ref:/);
  assert.match(action, /publish-source-sha:/);
  assert.match(action, /publish-source-locked:/);
  assert.match(action, /expected-publication-version:/);
  assert.match(action, /plan-before-target-advance:/);
  assert.match(action, /planned-publication-version:/);
  assert.match(action, /planned-release-candidate-version:/);
  assert.match(implementation, /expectedPublicationVersion/);
  assert.match(implementation, /planBeforeTargetAdvance/);
  assert.match(implementation, /planned-publication-version/);
  assert.match(implementation, /planned-release-candidate-version/);
  assert.match(implementation, /kungfu-buildchain-publish-source-lock-validation/);
  assert.match(implementation, /publish-gate\/\{alpha,release,major\}/);
  assert.match(implementation, /does not match promotion sha/);
});

test("promote wrapper exposes controlled branch-protection review bypass", () => {
  const action = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/action.yml"),
    "utf8",
  );
  const implementation = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/index.js"),
    "utf8",
  );
  const wrapper = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const publicWrapper = fs.readFileSync(
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
    "utf8",
  );

  assert.match(action, /branch-protection-bypass-apps:/);
  assert.match(action, /branch-protection-bypass-users:/);
  assert.match(action, /branch-protection-bypass-teams:/);
  assert.match(action, /generated-pull-request-token:/);
  assert.match(action, /generated-ref-update-token:/);
  assert.match(implementation, /branchProtectionBypassApps/);
  assert.match(implementation, /generatedRefUpdateToken/);
  assert.match(implementation, /generatedPullRequestToken/);
  assert.match(implementation, /pullRequestOctokit/);
  assert.match(implementation, /refUpdateOctokit/);
  assert.match(wrapper, /branch-protection-bypass-apps:/);
  assert.match(wrapper, /default: "github-actions"/);
  assert.match(wrapper, /branch-protection-bypass-users:/);
  assert.match(wrapper, /branch-protection-bypass-teams:/);
  assert.match(wrapper, /branch-protection-bypass-apps: \$\{\{ inputs\.branch-protection-bypass-apps \}\}/);
  assert.match(wrapper, /checks: write/);
  assert.match(wrapper, /pull-requests: write/);
  assert.equal(publicWrapper.match(/artifact-metadata: write/g)?.length, 3);
  assert.equal(publicWrapper.match(/attestations: write/g)?.length, 3);
  assert.equal(publicWrapper.match(/pull-requests: write/g)?.length, 3);
  assert.match(wrapper, /token: \$\{\{ github\.token \}\}/);
  assert.match(wrapper, /generated-status-check-token: \$\{\{ github\.token \}\}/);
  assert.match(
    wrapper,
    /generated-pull-request-token: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \|\| github\.token \}\}/,
  );
  assert.match(wrapper, /BUILDCHAIN_PROMOTION_TOKEN:\n\s+description:/);
  assert.match(
    wrapper,
    /generated-ref-update-token: \$\{\{ github\.token \}\}/,
  );

  const selfPromotion = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-ref-promotion.yml"),
    "utf8",
  );
  assert.match(selfPromotion, /checks: write/);
  assert.match(selfPromotion, /pull-requests: write/);
  assert.match(selfPromotion, /BUILDCHAIN_PROMOTION_BYPASS_APPS/);
  assert.doesNotMatch(selfPromotion, /BUILDCHAIN_PROMOTION_BYPASS_USERS/);
  assert.doesNotMatch(selfPromotion, /BUILDCHAIN_PROMOTION_BYPASS_TEAMS/);
});

test("Buildchain stable promotion gates publication after RC resolution", () => {
  const wrapper = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const policy = JSON.parse(fs.readFileSync(
    path.join(root, ".buildchain/stable-release-policy.json"),
    "utf8",
  ));
  const rcIndex = wrapper.indexOf("- name: Resolve PR-stage release candidate");
  const stableCandidateIndex = wrapper.indexOf("- name: Resolve Buildchain stable candidate alpha");
  const stableGateIndex = wrapper.indexOf("- name: Enforce Buildchain stable release canary gate");
  const immediateAuthorityIndex = wrapper.indexOf("- name: Record Buildchain immediate stable authority");
  const publishGateIndex = wrapper.indexOf("- name: Ensure publish-gate ref locks promotion commit");

  assert.ok(
    rcIndex >= 0 &&
      stableCandidateIndex > rcIndex &&
      stableGateIndex > stableCandidateIndex &&
      immediateAuthorityIndex > stableGateIndex &&
      publishGateIndex > immediateAuthorityIndex,
  );
  assert.match(wrapper, /needs\.preflight\.outputs\.channel == 'release'/);
  assert.match(
    wrapper,
    /BUILDCHAIN_RELEASE_CANDIDATE_VERSION: \$\{\{ needs\.publication-plan\.outputs\.release-candidate-version \}\}/,
  );
  assert.match(
    wrapper,
    /Buildchain stable publication plan must bind an exact alpha candidate version/,
  );
  assert.match(
    wrapper,
    /Buildchain stable candidate \$\{version\} does not match planned publication/,
  );
  assert.match(
    wrapper,
    /BUILDCHAIN_RELEASE_CANDIDATE_VERSION: \$\{\{ steps\.buildchain-stable-candidate\.outputs\.version \}\}/,
  );
  assert.match(wrapper, /node \.buildchain\/runtime\/scripts\/stable-release-gate\.mjs/);
  assert.match(
    wrapper,
    /vars\.BUILDCHAIN_STABLE_RELEASE_NOW != steps\.buildchain-stable-candidate\.outputs\.version/,
  );
  assert.match(
    wrapper,
    /vars\.BUILDCHAIN_STABLE_RELEASE_NOW == steps\.buildchain-stable-candidate\.outputs\.version/,
  );
  assert.match(wrapper, /Immediate stable release authorized/);
  assert.equal(policy.minimumStableIntervalSeconds, 86400);
  assert.equal(policy.minimumCanarySoakSeconds, 3600);
  assert.deepEqual(
    policy.requiredCanaries.map((canary) => canary.id),
    ["build-surface-fixture", "site-libkungfu-dev"],
  );
});

test("promotion commits consumer discovery authority only after public release assets", () => {
  const wrapper = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const topologyIndex = wrapper.indexOf(
    "- name: Validate final publication commit topology",
  );
  const publishGateIndex = wrapper.indexOf(
    "- name: Ensure publish-gate ref locks promotion commit",
  );
  const promoteIndex = wrapper.indexOf("- name: Promote-only publish");
  const commitIndex = wrapper.indexOf(
    "- name: Commit consumer publication authority last",
  );
  const evidenceIndex = wrapper.indexOf(
    "- name: Bundle release-candidate-promotion controller evidence",
  );

  assert.ok(
    topologyIndex >= 0 &&
      publishGateIndex > topologyIndex &&
      promoteIndex > publishGateIndex &&
      commitIndex > promoteIndex &&
      evidenceIndex > commitIndex,
  );
  assert.match(wrapper, /github-release-payload-patterns:/);
  assert.match(
    wrapper,
    /github-release-artifact-paths: \$\{\{ steps\.rc\.outputs\.release-candidate-github-release-artifact-paths \}\}/,
  );
  assert.match(wrapper, /publication-commit-command:/);
  assert.match(wrapper, /BUILDCHAIN_PUBLICATION_COMMIT_TOKEN:/);
  assert.match(wrapper, /BUILDCHAIN_PUBLICATION_COMMIT_SIGNING_KEY:/);
  assert.match(
    wrapper,
    /KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY:/,
  );
  assert.match(
    fs.readFileSync(
      path.join(root, ".github/workflows/release-candidate-promote.yml"),
      "utf8",
    ),
    /KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY:/,
  );
  assert.match(
    wrapper,
    /node \.buildchain\/runtime\/scripts\/publication-commit-evidence\.mjs/,
  );
  assert.match(
    wrapper,
    /publication-commit-command requires standalone-binary-distribution=false/,
  );
  assert.match(
    wrapper,
    /PUBLICATION_COMMIT_EVIDENCE.*publication-commit-evidence\.json/s,
  );
  assert.match(
    wrapper,
    /Commit consumer publication authority last[\s\S]*?steps\.promote\.outputs\.finalization-needed != 'true'/,
  );
  assert.match(
    wrapper,
    /Bundle release-candidate-promotion controller evidence[\s\S]*?steps\.promote\.outcome == 'success'/,
  );
  assert.match(wrapper, /FINALIZATION_NEEDED: \$\{\{ steps\.promote\.outputs\.finalization-needed \}\}/);
  assert.match(wrapper, /if \(!finalizationNeeded\) \{[\s\S]*?release-passport\.json/);
  assert.match(
    wrapper,
    /needs\.promote\.outputs\.finalization-needed == 'true'[\s\S]*?release-candidate-passport[\s\S]*?publish-evidence[\s\S]*?needs\.promote\.result == 'success'[\s\S]*?release-passport/,
  );
  assert.match(wrapper, /finalization-needed: \$\{\{ steps\.promote\.outputs\.finalization-needed \}\}/);
  assert.match(wrapper, /promotion-finalization-pending/);
  assert.match(
    wrapper,
    /needs\.promote\.outputs\.finalization-needed == 'true' && 'partial'/,
  );
  assert.match(
    wrapper,
    /Enforce qualifying release-candidate-promotion controller receipt[\s\S]*?needs\.promote\.outputs\.finalization-needed != 'true'[\s\S]*?controller-receipt-qualifying != 'true'/,
  );
});

test("reusable build exposes release-candidate passport outputs", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.build.yml"),
    "utf8",
  );

  assert.match(workflow, /release-candidate:/);
  assert.match(workflow, /release-candidate-family-evidence-json:/);
  assert.match(workflow, /github-artifact-attestation-subject-path:/);
  assert.match(workflow, /github-artifact-attestation-signer-sha:/);
  assert.match(workflow, /BUILDCHAIN_GITHUB_ATTESTATION_SIGNER_SHA:/);
  assert.match(workflow, /name: Create GitHub artifact attestation policy/);
  assert.match(workflow, /create-github-artifact-attestation-policy\.mjs/);
  assert.match(workflow, /name: Upload GitHub artifact attestation policy/);
  assert.match(workflow, /publish-source-tree-sha:/);
  assert.match(workflow, /Resolve source tree SHA/);
  assert.match(workflow, /Generate release candidate passport/);
  assert.match(workflow, /BUILDCHAIN_RC_SOURCE_TREE_HASH/);
  assert.match(workflow, /release-candidate-passport-artifact/);
  assert.match(workflow, /release-candidate-passport-json/);
  assert.match(workflow, /gate-profile-aggregate-json:/);
  assert.match(workflow, /BUILDCHAIN_GATE_PROFILE_AGGREGATE_JSON/);
  assert.match(workflow, /BUILDCHAIN_RC_FAMILY_EVIDENCE_JSON/);
  assert.match(workflow, /<artifact-name>-release-candidate-|release-candidate-/);
});

test("reusable build exposes runner-local tools before lifecycle execution", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.build.yml"),
    "utf8",
  );

  assert.match(workflow, /name: Expose Windows runner user toolchain/);
  assert.match(workflow, /Join-Path \$HOME "\.local\\bin"/);
  assert.match(workflow, /Join-Path \$HOME "\.cargo\\bin"/);
  assert.match(workflow, /name: Expose POSIX runner user toolchain/);
  assert.match(workflow, /\$\{HOME\}\/\.local\/bin/);
  assert.match(workflow, /\$\{HOME\}\/\.cargo\/bin/);
  const nativeBuild = workflow.slice(workflow.indexOf("  build-native:"));
  assert.ok(
    nativeBuild.indexOf("name: Expose Windows runner user toolchain") <
      nativeBuild.indexOf("name: Install Buildchain runtime dependencies"),
  );
});

test("reusable Shifu Gate workflow keeps project policy outside Buildchain", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.gate-profile.yml"),
    "utf8",
  );
  assert.match(workflow, /gate-profile:/);
  assert.match(workflow, /gate-command-json:/);
  assert.match(workflow, /gate-plan-command-json:/);
  assert.match(workflow, /BUILDCHAIN_GATE_PLAN_COMMAND_JSON/);
  assert.match(workflow, /gate-environment-json:/);
  assert.match(workflow, /shifu-cache-profile-ref:/);
  assert.match(workflow, /platforms-json:/);
  assert.match(workflow, /checkout-cache-mode:/);
  assert.match(workflow, /checkout-cache-fallback:/);
  assert.match(workflow, /checkout-cache-fetch-attempts:/);
  assert.match(workflow, /rust-toolchain:/);
  assert.match(workflow, /rustup-dist-server:/);
  assert.match(workflow, /rustup-update-root:/);
  assert.match(workflow, /cargo-registry-index:/);
  assert.match(workflow, /shifu-gate-profile\.mjs --mode plan/);
  assert.match(workflow, /shifu-gate-profile\.mjs --mode run/);
  assert.match(workflow, /shifu-gate-profile\.mjs --mode aggregate/);
  assert.match(workflow, /name: Gate profile \/ aggregate/);
  assert.match(workflow, /gate-aggregate-json:/);
  assert.match(workflow, /Reset prior Windows Gate source workspace/);
  assert.match(workflow, /runner\.os == 'Windows'/);
  assert.match(workflow, /rd \/s \/q/);
  assert.match(workflow, /windows-gate-source-git/);
  assert.match(workflow, /Move-Item -LiteralPath \$sourceGit/);
  assert.match(workflow, /refusing to clean Gate source outside GITHUB_WORKSPACE/);
  assert.match(workflow, /name: Expose Windows runner user toolchain/);
  assert.match(workflow, /Join-Path \$HOME "\.local\\bin"/);
  assert.match(workflow, /Join-Path \$HOME "\.cargo\\bin"/);
  assert.match(workflow, /name: Expose POSIX runner user toolchain/);
  assert.match(workflow, /\$\{HOME\}\/\.local\/bin/);
  assert.match(workflow, /\$\{HOME\}\/\.cargo\/bin/);
  assert.match(workflow, /name: Setup Rust toolchain on Windows/);
  assert.match(workflow, /contains\(matrix\.gate\.capabilities, 'rust'\)/);
  assert.match(workflow, /buildchain-gate-cargo-/);
  assert.match(workflow, /name: Setup Rust toolchain/);
  assert.match(workflow, /dtolnay\/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30/);
  assert.match(workflow, /name: Upload Buildchain runtime checkout bootstrap/);
  assert.match(workflow, /name: Download Buildchain runtime checkout bootstrap/);
  assert.equal(
    (workflow.match(/node \.buildchain\/runtime-bootstrap\/locked-source-checkout\.mjs/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/BUILDCHAIN_SOURCE_CHECKOUT_DIAGNOSTICS_PATH:/g) || []).length,
    2,
  );
  assert.match(workflow, /name: Upload locked checkout diagnostics/);
  assert.doesNotMatch(workflow, /product\.verify|gate\.catalog|dev-patrol|alpha-pr|release-pr/);
});

test("build surface fixture can dogfood artifact transfer modes declaratively", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/build-surface-fixture.yml"),
    "utf8",
  );
  assert.match(workflow, /- dev\/v\*\/v\*/);
  assert.match(workflow, /- alpha\/v\*\/v\*/);
  assert.match(workflow, /- release\/v\*\/v\*/);
  assert.doesNotMatch(workflow, /v\*\.\*/);
  assert.match(workflow, /artifact-transfer-mode:/);
  assert.match(workflow, /default: "github-artifacts"/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /secrets: inherit/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/build\.yml/);
  assert.match(
    workflow,
    /buildchain-ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  assert.match(
    workflow,
    /artifact-transfer-mode: \$\{\{ github\.event\.inputs\['artifact-transfer-mode'\] \|\| 'github-artifacts' \}\}/,
  );
  assert.match(workflow, /buildchain-contract-drift-issue-mode: "off"/);
  assert.match(workflow, /checkout-cache-mode: auto/);
  assert.match(workflow, /checkout-cache-fallback: github/);
  assert.match(
    workflow,
    /buildchain-package-candidate:[\s\S]*?if: \$\{\{ needs\.libnode-shaped\.result == 'success' && github\.event_name == 'pull_request' && \(startsWith\(github\.base_ref, 'alpha\/'\) \|\| startsWith\(github\.base_ref, 'release\/'\)\) \}\}/,
  );
  assert.match(workflow, /pattern: libnode-shaped-release-candidate-\*/);
  assert.match(workflow, /merge-multiple: true/);
  assert.match(workflow, /name: Plan the exact self-publication version before sealing product bytes/);
  assert.match(workflow, /uses: \.\/actions\/promote-buildchain-ref/);
  assert.match(workflow, /plan-before-target-advance: "true"/);
  assert.match(
    workflow,
    /corepack pnpm@11\.7\.0 install --frozen-lockfile --ignore-scripts[\s\S]*node scripts\/materialize-self-release-candidate-version\.mjs/,
  );
  assert.match(workflow, /publish-transaction: "true"/);
  assert.match(workflow, /name: Materialize the planned version in the candidate workspace/);
  assert.match(workflow, /node scripts\/materialize-self-release-candidate-version\.mjs/);
  assert.match(workflow, /EXPECTED_VERSION: \$\{\{ steps\.publication-plan\.outputs\.planned-publication-version \}\}/);
  assert.match(workflow, /sealed package version .* differs from planned publication/);
  assert.ok(
    workflow.indexOf("name: Materialize the planned version in the candidate workspace") <
      workflow.indexOf("name: Download exact Release Candidate Passport"),
    "version state must be materialized before untracked candidate evidence is downloaded",
  );
  assert.ok(
    workflow.indexOf("name: Materialize the planned version in the candidate workspace") <
      workflow.indexOf("name: Pack Buildchain product bytes once and bind them to the candidate"),
    "the exact publication version must exist before product bytes are sealed",
  );
  assert.doesNotMatch(
    workflow,
    /needs\.libnode-shaped\.outputs\['release-candidate-artifact'\]/,
  );
  assert.doesNotMatch(workflow, /run: node scripts\/artifact-relay-s3\.mjs/);
});

test("self-release candidate materialization applies complete declared version state", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-self-release-version-"));
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/buildchain.toml"),
    `schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[[version.files]]
type = "json"
path = "generated.json"
key = "product.version"

[lifecycle.version-state]
command = "node scripts/derive.mjs"
`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ name: "self-release-fixture", version: "1.0.0" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "generated.json"),
    `${JSON.stringify({ product: { version: "1.0.0" }, source: "" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "scripts/derive.mjs"),
    `import fs from "node:fs";
const generated = JSON.parse(fs.readFileSync("generated.json", "utf8"));
generated.product.version = process.env.BUILDCHAIN_VERSION;
generated.source = process.env.BUILDCHAIN_SOURCE_SHA;
fs.writeFileSync("generated.json", JSON.stringify(generated, null, 2) + "\\n");
`,
  );
  for (const args of [
    ["init"],
    ["config", "user.name", "Buildchain Test"],
    ["config", "user.email", "buildchain-test@example.com"],
    ["add", "."],
    ["commit", "-m", "test: initial version"],
  ]) {
    const run = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  }

  try {
    const sourceSha = "a".repeat(40);
    const result = materializeSelfReleaseCandidateVersion({
      cwd,
      version: "1.1.0-alpha.0",
      channel: "alpha",
      sourceSha,
      generatedAt: "2026-08-07T00:00:00.000Z",
    });
    assert.equal(result.version, "1.1.0-alpha.0");
    assert.deepEqual(result.files, ["generated.json", "package.json"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version, "1.1.0-alpha.0");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(cwd, "generated.json"), "utf8")),
      { product: { version: "1.1.0-alpha.0" }, source: sourceSha },
    );
    const status = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(status.stdout.trimEnd().split("\n").sort(), [" M generated.json", " M package.json"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("report issue action exposes workflow-friction feedback mode", () => {
  const action = fs.readFileSync(
    path.join(root, "actions/report-buildchain-issue/action.yml"),
    "utf8",
  );
  const implementation = fs.readFileSync(
    path.join(root, "actions/report-buildchain-issue/index.js"),
    "utf8",
  );
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );

  assert.match(action, /report-kind:/);
  assert.match(action, /workflow-friction/);
  assert.match(action, /comment-cooldown-hours:/);
  assert.match(action, /related-runs-json:/);
  assert.match(action, /heavy-builds-json:/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /buildchain-issue-token:/);
  assert.match(workflow, /buildchain-issue-app-id:/);
  assert.match(workflow, /buildchain-issue-app-private-key:/);
  assert.match(workflow, /Classify Buildchain promotion friction/);
  assert.match(workflow, /Resolve Buildchain issue token mode/);
  assert.match(workflow, /Create Buildchain issue token/);
  assert.match(workflow, /uses: actions\/create-github-app-token@v2/);
  assert.match(workflow, /BUILDCHAIN_BUILD_WORKFLOW_FILE: \$\{\{ inputs\.release-candidate-workflow-file \}\}/);
  assert.match(workflow, /BUILDCHAIN_BUILD_WORKFLOW_NAME: \$\{\{ inputs\.release-candidate-workflow-name \}\}/);
  assert.match(workflow, /BUILDCHAIN_PROMOTION_OUTCOME: \$\{\{ steps\.promote\.outcome \}\}/);
  assert.match(workflow, /BUILDCHAIN_PROMOTION_DIAGNOSIS: \$\{\{ steps\.promote\.outputs\.failure-message \}\}/);
  assert.match(workflow, /stable\.minimum_interval/);
  assert.match(workflow, /stable\.canary_soak/);
  assert.match(workflow, /echo "report=false" >> "\$\{GITHUB_OUTPUT\}"/);
  assert.match(workflow, /steps\.friction\.outputs\.report != 'false'/);
  assert.match(workflow, /reporter="\.buildchain\/runtime\/scripts\/workflow-friction-report\.mjs"/);
  assert.match(workflow, /reporter="scripts\/workflow-friction-report\.mjs"/);
  assert.match(workflow, /Report Buildchain promotion friction/);
  assert.match(
    workflow,
    /token: \$\{\{ steps\.buildchain-issue-app-token\.outputs\.token \|\| secrets\['buildchain-issue-token'\] \|\| secrets\.BUILDCHAIN_ISSUE_TOKEN \|\| github\.token \}\}/,
  );
  assert.doesNotMatch(workflow, /Report Buildchain promotion friction[\s\S]*token: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /body-file: \$\{\{ steps\.friction\.outputs\.body-file \}\}/);
  assert.match(implementation, /Copyable issue body/);
  assert.match(implementation, /buildWorkflowFrictionIssueReport/);
  assert.match(implementation, /recordBuildchainControlPlaneOutcome/);
  assert.match(action, /observability-log-path:/);
  assert.match(workflow, /Upload Buildchain control-plane observability/);
  assert.match(workflow, /\.buildchain\/logs\/events\.jsonl/);

  const promoteAction = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/action.yml"),
    "utf8",
  );
  const promoteImplementation = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/index.js"),
    "utf8",
  );
  assert.match(promoteAction, /failure-message:/);
  assert.match(promoteImplementation, /core\.setOutput\("failure-message", failureMessage\)/);
});

test("promote action exposes promote-only release candidate inputs", () => {
  const action = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/action.yml"),
    "utf8",
  );
  const implementation = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/index.js"),
    "utf8",
  );
  const docs = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/README.md"),
    "utf8",
  );

  assert.match(action, /promote-only-release-candidate:/);
  assert.match(action, /reconciliation-workspace:/);
  assert.match(action, /release-candidate-passport-path:/);
  assert.match(action, /release-candidate-build-summary-path:/);
  assert.match(action, /release-candidate-family-evidence-required:/);
  assert.match(action, /release-candidate-family-evidence-root:/);
  assert.match(action, /release-candidate-family-initiative-id:/);
  assert.match(action, /release-candidate-family-assignment-id:/);
  assert.match(action, /release-passport-kfd-1-witness-jsons:/);
  assert.match(action, /release-passport-kfd-2-claim-jsons:/);
  assert.match(action, /release-passport-kfd-3-prebuild-witness-jsons:/);
  assert.match(action, /release-passport-kfd-3-artifact-witness-jsons:/);
  assert.match(action, /release-passport-kfd-3-artifact-verify-command:/);
  assert.match(action, /release-passport-kfd-support-matrix-json:/);
  assert.match(action, /release-passport-kfd-product-gate-jsons:/);
  assert.match(action, /release-passport-invariant-passport-jsons:/);
  assert.match(action, /release-passport-invariant-passport-command:/);
  assert.match(action, /release-passport-evidence-jsons:/);
  assert.match(action, /release-passport-attachment-command:/);
  assert.match(action, /release-passport-evidence-command:/);
  assert.match(action, /release-passport-buildchain-self-kfd:/);
  assert.match(action, /publish-rematerialize-on-resume:/);
  assert.match(action, /release-passport-github-artifact-attestation-policy-jsons:/);
  assert.match(implementation, /promoteOnlyReleaseCandidate/);
  assert.match(implementation, /releaseCandidateFamilyEvidenceRequired/);
  assert.match(implementation, /releaseCandidateFamilyEvidenceRoot/);
  assert.match(implementation, /releaseCandidateFamilyInitiativeId/);
  assert.match(implementation, /releaseCandidateFamilyAssignmentId/);
  assert.match(implementation, /reconciliationWorkspace/);
  assert.match(implementation, /releasePassportKfd1WitnessJsons/);
  assert.match(implementation, /releasePassportKfd2ClaimJsons/);
  assert.match(implementation, /releasePassportKfd3PrebuildWitnessJsons/);
  assert.match(implementation, /releasePassportKfd3ArtifactWitnessJsons/);
  assert.match(implementation, /releasePassportKfd3ArtifactVerifyCommand/);
  assert.match(implementation, /releasePassportKfdSupportMatrixJson/);
  assert.match(implementation, /releasePassportKfdProductGateJsons/);
  assert.match(implementation, /releasePassportInvariantPassportJsons/);
  assert.match(implementation, /releasePassportInvariantPassportCommand/);
  assert.match(implementation, /releasePassportEvidenceJsons/);
  assert.match(implementation, /releasePassportAttachmentCommand/);
  assert.match(implementation, /releasePassportBuildchainSelfKfd/);
  assert.match(implementation, /publishRematerializeOnResume/);
  assert.match(implementation, /releasePassportGitHubArtifactAttestationPolicyJsons/);
  assert.match(docs, /promote-only-release-candidate: "true"/);
  assert.match(docs, /release-candidate-family-evidence-required: "true"/);
  assert.match(docs, /release-passport-kfd-1-witness-jsons/);
  assert.match(docs, /release-passport-kfd-2-claim-jsons/);
  assert.match(docs, /release-passport-kfd-3-prebuild-witness-jsons/);
  assert.match(docs, /release-passport-kfd-support-matrix-json/);
  assert.match(docs, /release-passport-kfd-product-gate-jsons/);
  assert.match(docs, /release-passport-invariant-passport-command/);
  assert.match(docs, /release-passport-evidence-jsons/);
  assert.match(docs, /release-passport-attachment-command/);
  assert.match(docs, /publish-rematerialize-on-resume: true/);
});

test("buildchain ref promotion consumes PR-stage release candidate evidence", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-ref-promotion.yml"),
    "utf8",
  );
  const bootstrap = fs.readFileSync(
    path.join(root, ".github/workflows/release-line-bootstrap.yml"),
    "utf8",
  );

  assert.match(
    workflow,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/release-candidate-promote\.yml@9a0cdf8d84aacf8c7daaac82efa43d1b34696a03\n    permissions:\n      actions: write\n      artifact-metadata: write\n      attestations: write/,
  );
  assert.doesNotMatch(workflow, /uses: \.\/\.github\/workflows\/\.release-candidate-promote\.yml/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /startsWith\(github\.event\.workflow_run\.head_branch, 'alpha\/'\)/);
  assert.match(workflow, /startsWith\(github\.event\.workflow_run\.head_branch, 'release\/'\)/);
  assert.match(workflow, /!startsWith\(github\.event\.workflow_run\.display_title, 'chore\(release\): prepare v'\)/);
  assert.match(workflow, /!startsWith\(github\.event\.workflow_run\.display_title, 'chore\(release\): release v'\)/);
  assert.match(
    workflow,
    /buildchain-ref: 9a0cdf8d84aacf8c7daaac82efa43d1b34696a03/,
  );
  assert.match(workflow, /declarative-release-tail: true/);
  assert.match(workflow, /target-ref: \$\{\{ github\.event\.workflow_run\.head_branch \|\| inputs\['target-ref'\] \}\}/);
  assert.match(workflow, /target-sha: \$\{\{ github\.event\.workflow_run\.head_sha \|\| inputs\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /package-manager: pnpm/);
  assert.match(workflow, /release-candidate-workflow-file: build-surface-fixture\.yml/);
  assert.match(workflow, /release-candidate-workflow-name: Build Surface Fixture/);
  assert.match(workflow, /github-release: true/);
  assert.match(workflow, /required-status-check: check(?:\n|$)/);
  assert.doesNotMatch(workflow, /required-status-check: check \/ check/);
  assert.match(
    bootstrap,
    /required-status-check:\n\s+description: "Exact required branch-protection check context"\n\s+required: false\n\s+default: "check"/,
  );
  assert.match(bootstrap, /GH_TOKEN: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \}\}/);
  assert.match(bootstrap, /token: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(bootstrap, /BUILDCHAIN_PROMOTION_BYPASS_(APPS|USERS|TEAMS)/);
  assert.match(bootstrap, /requires BUILDCHAIN_PROMOTION_TOKEN to configure branch protection/);
  assert.match(bootstrap, /apps: \["github-actions"\],\s*users: \[\],\s*teams: \[\]/);
  assert.match(bootstrap, /strict: \$release_channel/);
  assert.match(bootstrap, /map\(\{context: \., app_id: \$github_actions_app_id\}\)/);
  assert.match(bootstrap, /dismiss_stale_reviews: true/);
  assert.match(bootstrap, /require_code_owner_reviews: true/);
  assert.match(bootstrap, /require_last_push_approval: true/);
  assert.match(bootstrap, /name: Reconcile dev merge queue governance/);
  assert.match(bootstrap, /--from-config/);
  assert.ok(
    bootstrap.indexOf("name: Reconcile dev merge queue governance") <
      bootstrap.indexOf("name: Set default branch"),
  );
  assert.doesNotMatch(workflow, /publish-required-artifacts-json: "\[\]"/);
  assert.match(
    workflow,
    /publish-required-artifacts-json: \$\{\{ startsWith\(github\.event\.workflow_run\.head_branch \|\| inputs\['target-ref'\], 'release\/'\) && '\[\{"group":"node","kind":"npm","name":"@kungfu-tech\/buildchain","ref_template":"\{version\}","role":"main","required":true\}\]' \|\| '' \}\}/,
  );
  assert.match(workflow, /artifact-patterns: "buildchain-package-\*"/);
  assert.doesNotMatch(
    workflow,
    /artifact-patterns: \$\{\{ inputs\['resume-candidate-run-id'\] != ''/,
  );
  assert.match(workflow, /release-passport-impact-json: \.buildchain\/release-impact\.json/);
  assert.match(
    workflow,
    /publication-auto-admission: \$\{\{ github\.event_name == 'workflow_run' \|\| inputs\['recover-durable-transaction'\] == true \|\| inputs\['resume-candidate-run-id'\] != '' \}\}/,
  );
  assert.match(
    workflow,
    /publication-auto-no-gate: \$\{\{ github\.event_name == 'workflow_run' \|\| inputs\['recover-durable-transaction'\] == true \|\| inputs\['resume-candidate-run-id'\] != '' \}\}/,
  );
  assert.match(workflow, /publication-publisher-workflow-path: \.github\/workflows\/buildchain-ref-promotion\.yml/);
  assert.doesNotMatch(workflow, /Buildchain v2\.10 patch release/);
  assert.doesNotMatch(workflow, /run: node scripts\/release-candidate-resolver\.mjs/);
  assert.doesNotMatch(workflow, /uses: \.\/actions\/promote-buildchain-ref/);
});

test("promote-buildchain-ref owns semver GitHub Release publication", () => {
  const action = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/action.yml"),
    "utf8",
  );
  const source = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/index.js"),
    "utf8",
  );
  const githubReleaseSource = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/github-release.js"),
    "utf8",
  );
  const implementation = `${source}\n${githubReleaseSource}`;

  assert.match(action, /github-release:/);
  assert.match(action, /github-release-artifact-paths:/);
  assert.match(action, /github-release-title:/);
  assert.match(action, /github-release-notes:/);
  assert.match(action, /public-release-tag:/);
  assert.match(action, /github-release-url:/);
  assert.match(action, /github-release-action:/);
  assert.match(implementation, /ensureGitHubRelease/);
  assert.match(implementation, /publishGitHubReleaseEvidence/);
  assert.match(implementation, /collectGitHubReleaseEvidenceAssets/);
  assert.match(implementation, /duplicate asset basename/);
  assert.match(implementation, /uploadReleaseAsset/);
  assert.match(source, /publishTransaction\?\.state === "complete"/);
  assert.match(source, /transaction-state=/);
  assert.match(source, /finalizationNeeded !== true/);
});

test("publish source-lock docs distinguish source refs from promotion targets", () => {
  const docs = fs.readFileSync(
    path.join(root, "docs/reusable-build-surface.md"),
    "utf8",
  );

  assert.match(docs, /target-ref: release\/v22\/v22\.22/);
  assert.match(
    docs,
    /`target-ref` stays the Buildchain channel promotion target/,
  );
  assert.match(
    docs,
    /`publish-source-ref` is the reviewed source-lock branch/,
  );
  assert.match(
    docs,
    /source-lock branch must point at the exact channel-line commit/,
  );
  assert.match(docs, /it is not a replacement for `target-ref`/);
});

test("promote action docs describe publish source-lock inputs", () => {
  const docs = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/README.md"),
    "utf8",
  );

  assert.match(docs, /require-publish-source-lock: "true"/);
  assert.match(
    docs,
    /publish-source-ref: \$\{\{ needs\.build\.outputs\.publish-source-ref \}\}/,
  );
  assert.match(
    docs,
    /publish-source-sha: \$\{\{ needs\.build\.outputs\.publish-source-sha \}\}/,
  );
  assert.match(docs, /target-ref: release\/v22\/v22\.22/);
  assert.match(docs, /`target-ref` remains the channel promotion target/);
  assert.match(docs, /Direct `alpha\/\*` or `release\/\*` channel refs/);
  assert.match(docs, /fails before any promotion or publish side effects begin/);
});

test("runner presets resolve to explicit matrices", () => {
  const hosted = resolveRunnerMatrix({ runnerPreset: "github-hosted" });
  assert.equal(hosted.runnerPreset, "github-hosted");
  assert.equal(hosted.platformCount, 3);
  assert.equal(hosted.nativePlatformCount, 3);
  assert.equal(hosted.containerPlatformCount, 0);
  assert.equal(hosted.platforms[0].id, "linux-x64");
  assert.equal(hosted.githubHostedPlatformCount, 3);
  assert.equal(hosted.relayPlatformCount, 0);
  assert.deepEqual(JSON.parse(hosted.githubHostedPlatformIdsJson), [
    "linux-x64",
    "macos",
    "windows-x64",
  ]);

  const kungfu = resolveRunnerMatrix({ runnerPreset: "kungfu-v4-self-hosted" });
  assert.equal(kungfu.runnerPreset, "kungfu-v4-self-hosted");
  assert.equal(kungfu.nativePlatformCount, 3);
  assert.equal(kungfu.containerPlatformCount, 0);
  assert.deepEqual(
    kungfu.platforms.map((platform) => platform.id),
    ["linux-x64", "macos-arm64", "windows-x64"],
  );
  assert.match(kungfu.platforms[0].runner, /kungfu-build-v4-linux-x64/);
  assert.equal(kungfu.githubHostedPlatformCount, 0);
  assert.equal(kungfu.relayPlatformCount, 3);

  const kungfuNative = resolveRunnerMatrix({ runnerPreset: "kungfu-v4-native" });
  assert.equal(kungfuNative.runnerPreset, "kungfu-v4-native");
  assert.equal(kungfuNative.nativePlatformCount, 4);
  assert.equal(kungfuNative.containerPlatformCount, 0);
  assert.deepEqual(
    kungfuNative.platforms.map((platform) => platform.id),
    ["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"],
  );
  assert.equal(kungfuNative.platforms[1].runner, '["ubuntu-24.04-arm"]');
  assert.equal(kungfuNative.platforms[1].githubHosted, true);
  assert.equal(kungfuNative.githubHostedPlatformCount, 1);
  assert.equal(kungfuNative.relayPlatformCount, 3);

  const codebuild = resolveRunnerMatrix({
    runnerPreset: "aws-us-codebuild-linux",
    awsCodeBuildProject: "kungfu-buildchain-linux-burst-poc",
  });
  assert.equal(codebuild.runnerPreset, "aws-us-codebuild-linux");
  assert.equal(codebuild.platformCount, 1);
  assert.equal(codebuild.platforms[0].provider, "aws-codebuild");
  assert.equal(
    codebuild.platforms[0].project,
    "kungfu-buildchain-linux-burst-poc",
  );

  const windowsJit = resolveRunnerMatrix({
    runnerPreset: "aws-us-ec2-windows-jit",
    awsEc2WindowsRunnerLabel: "aws-us-ec2-windows-jit-full-01",
  });
  assert.equal(windowsJit.runnerPreset, "aws-us-ec2-windows-jit");
  assert.equal(windowsJit.platformCount, 1);
  assert.equal(windowsJit.platforms[0].provider, "aws-ec2-windows-jit");
  assert.match(windowsJit.platforms[0].runner, /windows-jit-full-01/);

  const macosJit = resolveRunnerMatrix({
    runnerPreset: "aws-us-ec2-macos-jit",
    awsEc2MacosRunnerLabel: "aws-us-ec2-macos-jit-full-01",
  });
  assert.equal(macosJit.runnerPreset, "aws-us-ec2-macos-jit");
  assert.equal(macosJit.platformCount, 1);
  assert.equal(macosJit.platforms[0].provider, "aws-ec2-macos-jit");
  assert.match(macosJit.platforms[0].runner, /macos-jit-full-01/);

  const custom = resolveRunnerMatrix({
    platformsJson:
      '[{"id":"linux","name":"Linux","runner":"[\\"self-hosted\\",\\"Linux\\"]","environment":{"CXX":"g++-14","CC":"gcc-14","JOBS":4}}]',
  });
  assert.equal(custom.runnerPreset, "custom");
  assert.equal(custom.platformCount, 1);
  assert.deepEqual(custom.platforms[0].environment, {
    CXX: "g++-14",
    CC: "gcc-14",
    JOBS: 4,
  });
  assert.deepEqual(JSON.parse(custom.platformsJson)[0].environment, {
    CXX: "g++-14",
    CC: "gcc-14",
    JOBS: 4,
  });
  assert.equal(custom.platforms[0].githubHosted, false);

  const customHosted = resolveRunnerMatrix({
    platformsJson:
      '[{"id":"hosted","name":"Hosted","runner":"[\\"ubuntu-24.04\\"]"},{"id":"large","name":"Large hosted","runner":"[\\"custom-large-runner\\"]","githubHosted":true}]',
  });
  assert.equal(customHosted.githubHostedPlatformCount, 2);
  assert.equal(customHosted.relayPlatformCount, 0);
  assert.deepEqual(JSON.parse(customHosted.githubHostedPlatformIdsJson), [
    "hosted",
    "large",
  ]);
  assert.throws(
    () =>
      resolveRunnerMatrix({
        platformsJson:
          '[{"id":"invalid","name":"Invalid","runner":"[\\"ubuntu-24.04\\"]","githubHosted":"true"}]',
      }),
    /githubHosted must be a boolean/,
  );
});

test("AWS CodeBuild runner preset fails closed without an exact project", () => {
  assert.throws(
    () => resolveRunnerMatrix({ runnerPreset: "aws-us-codebuild-linux" }),
    /requires a valid aws-codebuild-project/,
  );
  assert.throws(
    () =>
      resolveRunnerMatrix({
        runnerPreset: "aws-us-codebuild-linux",
        awsCodeBuildProject: "not valid",
      }),
    /requires a valid aws-codebuild-project/,
  );
});

test("AWS Windows EC2 JIT preset fails closed without a card-scoped label", () => {
  assert.throws(
    () => resolveRunnerMatrix({ runnerPreset: "aws-us-ec2-windows-jit" }),
    /runner label must match/,
  );
  assert.throws(
    () =>
      resolveRunnerMatrix({
        runnerPreset: "aws-us-ec2-windows-jit",
        awsEc2WindowsRunnerLabel: "kungfu-build-v4-windows-x64",
      }),
    /runner label must match/,
  );
});

test("AWS macOS EC2 JIT preset fails closed without a campaign-scoped label", () => {
  assert.throws(
    () => resolveRunnerMatrix({ runnerPreset: "aws-us-ec2-macos-jit" }),
    /runner label must match/,
  );
  assert.throws(
    () =>
      resolveRunnerMatrix({
        runnerPreset: "aws-us-ec2-macos-jit",
        awsEc2MacosRunnerLabel: "kungfu-build-v4-macos-arm64",
      }),
    /runner label must match/,
  );
});

test("linux container preset routes only Linux platforms into the container matrix", () => {
  assert.match(
    LINUX_CONTAINER_PRESETS["kungfu-verify"].image,
    /kungfu-verify@sha256:11f0ba/,
  );
  const resolved = resolveRunnerMatrix({
    runnerPreset: "kungfu-v4-self-hosted",
    linuxContainerPreset: "kungfu-verify",
  });
  assert.equal(resolved.linuxContainer.enabled, true);
  assert.equal(resolved.linuxContainer.preset, "kungfu-verify");
  assert.equal(
    resolved.linuxContainer.image,
    LINUX_CONTAINER_PRESETS["kungfu-verify"].image,
  );
  assert.deepEqual(
    resolved.containerPlatforms.map((platform) => platform.id),
    ["linux-x64"],
  );
  assert.deepEqual(
    resolved.nativePlatforms.map((platform) => platform.id),
    ["macos-arm64", "windows-x64"],
  );
  assert.equal(JSON.parse(resolved.containerPlatformsJson).length, 1);
  assert.equal(JSON.parse(resolved.nativePlatformsJson).length, 2);
});

test("explicit linux container image supports custom Linux matrices", () => {
  const resolved = resolveRunnerMatrix({
    platformsJson:
      '[{"id":"linux","name":"Linux","runner":"[\\"self-hosted\\",\\"Linux\\"]"},{"id":"macos","name":"macOS","runner":"[\\"macos-15\\"]"}]',
    linuxContainerImage: "ghcr.io/example/build@sha256:1234",
  });
  assert.equal(resolved.runnerPreset, "custom");
  assert.equal(resolved.linuxContainer.preset, "custom");
  assert.equal(
    resolved.linuxContainer.image,
    "ghcr.io/example/build@sha256:1234",
  );
  assert.deepEqual(
    resolved.containerPlatforms.map((platform) => platform.id),
    ["linux"],
  );
  assert.deepEqual(
    resolved.nativePlatforms.map((platform) => platform.id),
    ["macos"],
  );
});

test("linux container preset rejects ambiguous preset and image combinations", () => {
  assert.throws(
    () =>
      resolveRunnerMatrix({
        runnerPreset: "github-hosted",
        linuxContainerPreset: "kungfu-verify",
        linuxContainerImage: "ghcr.io/example/build@sha256:1234",
      }),
    /cannot be combined/,
  );
});

test("artifact name templates resolve deterministically", () => {
  const resolved = resolveArtifactContract({
    artifactName: "libnode",
    artifactNameTemplate: DEFAULT_ARTIFACT_NAME_TEMPLATE,
    platformId: "linux-x64",
    platformName: "Linux x64",
    sha: "1234567890abcdef",
  });
  assert.equal(resolved.artifactName, "libnode-linux-x64-1234567890abcdef");

  const short = resolveArtifactContract({
    artifactName: "libnode",
    artifactNameTemplate: "{artifact}-{platform}-{shortSha}-{ref}",
    platformId: "linux-x64",
    sha: "1234567890abcdef",
    ref: "refs/heads/dev/v1/v1.0",
  });
  assert.equal(
    short.artifactName,
    "libnode-linux-x64-1234567890ab-refs-heads-dev-v1-v1.0",
  );
});

test("publish gate separates verification trust from publish eligibility", () => {
  assert.deepEqual(
    resolvePublishGate({
      trusted: true,
      publishChannel: "release",
      eventName: "push",
      ref: "refs/heads/release/v2/v2.0",
    }),
    {
      trusted: true,
      publishChannel: "release",
      publishAllowed: true,
      publishReason: "ref matched ^refs/heads/release/v\\d+/v\\d+\\.\\d+$",
    },
  );

  const sameRepoPr = resolvePublishGate({
    trusted: true,
    publishChannel: "release",
    eventName: "pull_request",
    ref: "refs/pull/123/merge",
  });
  assert.equal(sameRepoPr.publishAllowed, false);
  assert.match(sameRepoPr.publishReason, /pull_request events may verify/);

  const forkPr = resolvePublishGate({
    trusted: false,
    publishChannel: "alpha",
    eventName: "pull_request",
    ref: "refs/pull/456/merge",
  });
  assert.equal(forkPr.publishAllowed, false);
  assert.equal(forkPr.publishReason, "event is not trusted");

  assert.equal(
    resolvePublishGate({
      trusted: true,
      publishChannel: "alpha",
      eventName: "push",
      ref: "refs/tags/v2.0.5-alpha.0",
    }).publishAllowed,
    true,
  );
});

test("publish gate supports custom publish channels", () => {
  const resolved = resolvePublishGate({
    trusted: true,
    publishChannel: "nightly",
    eventName: "push",
    ref: "refs/heads/nightly/v2",
    publishRefsJson: '{"nightly":["^refs/heads/nightly/v\\\\d+$"]}',
  });
  assert.equal(resolved.publishAllowed, true);
  assert.equal(resolved.publishChannel, "nightly");

  assert.equal(
    resolvePublishGate({
      trusted: true,
      publishChannel: "nightly",
      eventName: "push",
      ref: "refs/heads/dev/v2/v2.0",
      publishRefsJson: '{"nightly":["^refs/heads/nightly/v\\\\d+$"]}',
    }).publishAllowed,
    false,
  );
});

test("publish source refs parse gate channel, line, and consumer version", () => {
  assert.deepEqual(
    parsePublishSourceRef("publish-gate/alpha/v22/v22.22/22.22.3-kf.0"),
    {
      sourceRef: "publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
      fullRef: "refs/heads/publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
      enabled: true,
      channel: "alpha",
      line: "v22/v22.22",
      consumerVersion: "22.22.3-kf.0",
      anchor: false,
      legacyAlias: false,
    },
  );
  assert.equal(
    parsePublishSourceRef("publish-gate/release/v22/v22.22/22.22.3-kf.0")
      .channel,
    "release",
  );
  assert.equal(parsePublishSourceRef("publish-gate/anchor").anchor, true);
  assert.equal(parsePublishSourceRef("publish-gate/major").legacyAlias, false);
  assert.equal(parsePublishSourceRef("major-gate").legacyAlias, true);
  assert.throws(
    () => parsePublishSourceRef("publish-gate/alpha/v22/22.22.3-kf.0"),
    /line must include/,
  );
});

test("publish source manifest binds gate version to configured version state", async () => {
  const fixture = path.join(root, "fixtures/libnode-shaped");
  const sourceSha = "a".repeat(40);
  const manifest = await createResolvedReleaseManifest({
    cwd: fixture,
    repository: "kungfu-systems/libnode",
    sourceRef: "publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
    sourceSha,
  });
  assert.equal(manifest.sourceSha, sourceSha);
  assert.equal(manifest.channel, "alpha");
  assert.equal(manifest.line, "v22/v22.22");
  assert.equal(manifest.consumerVersion, "22.22.3-kf.0");
  assert.equal(manifest.versionStrategy, "anchored");
  assert.equal(manifest.versionNext, "manual");
  assert.deepEqual(manifest.versionFiles, [
    {
      path: "package.json",
      type: "json",
      key: "version",
      version: "22.22.3-kf.0",
    },
  ]);
  assert.equal(manifest.anchorManifest.path, "libnode.release.json");
  assert.equal(manifest.anchorManifest.summary.npmVersion, "22.22.3-kf.0");
  assert.equal(manifest.publish.distTag, "alpha");
});

test("publish source manifest fails closed on version mismatch", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-source-lock-"),
  );
  const fixture = path.join(workspace, "fixture");
  fs.cpSync(path.join(root, "fixtures/libnode-shaped"), fixture, {
    recursive: true,
  });
  try {
    await assert.rejects(
      async () =>
        await createResolvedReleaseManifest({
          cwd: fixture,
          sourceRef: "publish-gate/release/v22/v22.22/22.22.3-kf.1",
          sourceSha: "b".repeat(40),
        }),
      /version mismatch/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
test("publish source lock fails closed when branch moved", () => {
  assert.deepEqual(
    resolvePublishSourceLock({
      fallbackRef: "refs/pull/103/merge",
      fallbackSha: "1".repeat(40),
    }),
    {
      sourceRef: "",
      fullRef: "",
      enabled: false,
      channel: "none",
      line: "",
      consumerVersion: "",
      anchor: false,
      legacyAlias: false,
      fallbackRef: "refs/pull/103/merge",
      fallbackFullRef: "refs/pull/103/merge",
      sourceSha: "1".repeat(40),
      sourceLocked: false,
      sourceReason: "publish source ref is not configured",
    },
  );
  assert.deepEqual(
    resolvePublishSourceLock({
      publishSourceRef: "publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
      publishSourceSha: "c".repeat(40),
    }),
    {
      sourceRef: "publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
      fullRef: "refs/heads/publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
      enabled: true,
      channel: "alpha",
      line: "v22/v22.22",
      consumerVersion: "22.22.3-kf.0",
      anchor: false,
      legacyAlias: false,
      sourceSha: "c".repeat(40),
      sourceLocked: true,
      sourceReason: `locked publish-gate/alpha/v22/v22.22/22.22.3-kf.0 at ${"c".repeat(40)}`,
    },
  );
  assert.throws(
    () =>
      verifyPublishSourceLock({
        sourceRef: "publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
        expectedSha: "c".repeat(40),
        currentSha: "d".repeat(40),
      }),
    /publish source ref moved/,
  );
});

test("publish source resolver uses current push ref without remote access", async () => {
  const sourceRef = "publish-gate/alpha/v22/v22.22/22.22.3-kf.0";
  const sourceSha = "a".repeat(40);
  const env = {
    BUILDCHAIN_PUBLISH_SOURCE_REF: sourceRef,
    BUILDCHAIN_SOURCE_REPOSITORY: "kungfu-systems/libnode",
    GITHUB_REF: `refs/heads/${sourceRef}`,
    GITHUB_REF_NAME: sourceRef,
    GITHUB_SHA: sourceSha,
  };
  const fetchImpl = async () => {
    throw new Error(
      "remote resolver should not be called for current push ref",
    );
  };

  assert.equal(currentGitHubRefSha(sourceRef, env), sourceSha);
  assert.equal(
    await resolvePublishSourceRefSha({
      repository: env.BUILDCHAIN_SOURCE_REPOSITORY,
      sourceRef,
      env,
      fetchImpl,
    }),
    sourceSha,
  );

  const lock = await resolvePublishSourceCli({
    args: ["--mode", "lock"],
    env,
    fetchImpl,
  });
  assert.equal(lock.sourceRef, sourceRef);
  assert.equal(lock.sourceSha, sourceSha);
  assert.equal(lock.sourceLocked, true);
});

test("publish source resolver reads non-current slash-heavy refs through GitHub API", async () => {
  const sourceRef = "publish-gate/alpha/v22/v22.22/22.22.3-kf.0";
  const sourceSha = "b".repeat(40);
  const env = {
    GITHUB_REF: "refs/heads/alpha/v22/v22.22",
    GITHUB_REF_NAME: "alpha/v22/v22.22",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_TOKEN: "token",
  };
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ object: { sha: sourceSha } }),
    };
  };

  assert.equal(
    await resolvePublishSourceRefSha({
      repository: "kungfu-systems/libnode",
      sourceRef,
      env,
      fetchImpl,
    }),
    sourceSha,
  );
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    "https://api.github.com/repos/kungfu-systems/libnode/git/ref/heads/publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
  );
  assert.equal(seen[0].options.headers.Authorization, "Bearer token");
});

test("verify publish source lock fails closed when API ref has moved", async () => {
  const sourceRef = "publish-gate/alpha/v22/v22.22/22.22.3-kf.0";
  const env = {
    BUILDCHAIN_PUBLISH_SOURCE_REF: sourceRef,
    BUILDCHAIN_PUBLISH_SOURCE_SHA: "c".repeat(40),
    BUILDCHAIN_SOURCE_REPOSITORY: "kungfu-systems/libnode",
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ object: { sha: "d".repeat(40) } }),
  });

  await assert.rejects(
    async () => await verifyPublishSourceLockCli({ env, fetchImpl }),
    /publish source ref moved/,
  );
});

test("verify publish source lock accepts unchanged current push ref", async () => {
  const sourceRef = "publish-gate/alpha/v22/v22.22/22.22.3-kf.0";
  const sourceSha = "e".repeat(40);
  const env = {
    BUILDCHAIN_PUBLISH_SOURCE_REF: sourceRef,
    BUILDCHAIN_PUBLISH_SOURCE_SHA: sourceSha,
    BUILDCHAIN_SOURCE_REPOSITORY: "kungfu-systems/libnode",
    GITHUB_REF: `refs/heads/${sourceRef}`,
    GITHUB_REF_NAME: sourceRef,
    GITHUB_SHA: sourceSha,
  };
  const fetchImpl = async () => {
    throw new Error(
      "remote resolver should not be called for current push ref",
    );
  };

  assert.deepEqual(await verifyPublishSourceLockCli({ env, fetchImpl }), {
    ok: true,
    sourceRef,
    sourceSha,
  });
});

test("publish source channel refs must match the locked source sha", async () => {
  const sourceRef = "publish-gate/alpha/v22/v22.22/22.22.3-kf.0";
  const sourceSha = "e".repeat(40);
  assert.equal(
    resolvePublishChannelTargetRef({ sourceRef }),
    "alpha/v22/v22.22",
  );
  assert.deepEqual(
    verifyPublishChannelRef({
      sourceRef,
      sourceSha,
      targetSha: sourceSha,
    }),
    {
      ok: true,
      skipped: false,
      sourceRef,
      sourceSha,
      targetRef: "alpha/v22/v22.22",
      targetSha: sourceSha,
    },
  );
  assert.throws(
    () =>
      verifyPublishChannelRef({
        sourceRef,
        sourceSha,
        targetSha: "f".repeat(40),
      }),
    /Merge the source commit through the channel PR into alpha\/v22\/v22\.22/,
  );

  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    if (url.endsWith(`/commits/${sourceSha}/pulls`)) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            number: 123,
            html_url: "https://github.com/kungfu-systems/libnode/pull/123",
            merged_at: "2026-07-03T00:00:00Z",
            base: { ref: "alpha/v22/v22.22" },
            head: {
              ref: "dev/v22/v22.22",
              repo: { full_name: "kungfu-systems/libnode" },
            },
          },
        ],
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ object: { sha: sourceSha } }),
    };
  };
  assert.deepEqual(
    await verifyPublishChannelRefCli({
      env: {
        BUILDCHAIN_PUBLISH_SOURCE_REF: sourceRef,
        BUILDCHAIN_PUBLISH_SOURCE_SHA: sourceSha,
        BUILDCHAIN_SOURCE_REPOSITORY: "kungfu-systems/libnode",
        GITHUB_TOKEN: "token",
      },
      fetchImpl,
    }),
    {
      ok: true,
      skipped: false,
      sourceRef,
      sourceSha,
      targetRef: "alpha/v22/v22.22",
      targetSha: sourceSha,
      prLineage: {
        ok: true,
        skipped: false,
        sourceRef,
        sourceSha,
        targetRef: "alpha/v22/v22.22",
        expectedHeadRef: "dev/v22/v22.22",
        pullRequest: {
          number: 123,
          url: "https://github.com/kungfu-systems/libnode/pull/123",
          headRef: "dev/v22/v22.22",
          baseRef: "alpha/v22/v22.22",
          mergedAt: "2026-07-03T00:00:00Z",
        },
      },
    },
  );
  assert.equal(
    seen[0].url,
    "https://api.github.com/repos/kungfu-systems/libnode/git/ref/heads/alpha/v22/v22.22",
  );
  assert.equal(seen[0].options.headers.Authorization, "Bearer token");
  assert.equal(
    seen[1].url,
    `https://api.github.com/repos/kungfu-systems/libnode/commits/${sourceSha}/pulls`,
  );

  await assert.rejects(
    async () =>
      await verifyPublishChannelRefCli({
        env: {
          BUILDCHAIN_PUBLISH_SOURCE_REF:
            "publish-gate/release/v22/v22.22/22.22.3-kf.0",
          BUILDCHAIN_PUBLISH_SOURCE_SHA: sourceSha,
          BUILDCHAIN_CURRENT_TARGET_SHA: "a".repeat(40),
          BUILDCHAIN_SOURCE_REPOSITORY: "kungfu-systems/libnode",
        },
        fetchImpl,
      }),
    /Merge the source commit through the channel PR into release\/v22\/v22\.22/,
  );
});

test("publish source channel refs require merged same-repository PR lineage", () => {
  const sourceRef = "publish-gate/release/v22/v22.22/22.22.3-kf.0";
  const sourceSha = "e".repeat(40);
  assert.deepEqual(
    verifyPublishChannelPrLineage({
      sourceRef,
      sourceSha,
      repository: "kungfu-systems/libnode",
      pullRequests: [
        {
          number: 456,
          html_url: "https://github.com/kungfu-systems/libnode/pull/456",
          merged_at: "2026-07-03T00:00:00Z",
          base: { ref: "release/v22/v22.22" },
          head: {
            ref: "alpha/v22/v22.22",
            repo: { full_name: "kungfu-systems/libnode" },
          },
        },
      ],
    }),
    {
      ok: true,
      skipped: false,
      sourceRef,
      sourceSha,
      targetRef: "release/v22/v22.22",
      expectedHeadRef: "alpha/v22/v22.22",
      pullRequest: {
        number: 456,
        url: "https://github.com/kungfu-systems/libnode/pull/456",
        headRef: "alpha/v22/v22.22",
        baseRef: "release/v22/v22.22",
        mergedAt: "2026-07-03T00:00:00Z",
      },
    },
  );
  assert.throws(
    () =>
      verifyPublishChannelPrLineage({
        sourceRef: "publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
        sourceSha,
        repository: "kungfu-systems/libnode",
        pullRequests: [
          {
            merged_at: "2026-07-03T00:00:00Z",
            base: { ref: "alpha/v22/v22.22" },
            head: {
              ref: "feature/direct",
              repo: { full_name: "kungfu-systems/libnode" },
            },
          },
        ],
      }),
    /merged same-repository PR dev\/v22\/v22\.22 -> alpha\/v22\/v22\.22/,
  );
  assert.doesNotThrow(() =>
    verifyPublishChannelPrLineage({
      sourceRef: "publish-gate/major",
      sourceSha,
      repository: "kungfu-systems/buildchain",
      pullRequests: [
        {
          merged_at: "2026-07-03T00:00:00Z",
          base: { ref: "publish-gate/major" },
          head: {
            ref: "release/v22/v22.22",
            repo: { full_name: "kungfu-systems/buildchain" },
          },
        },
      ],
    }),
  );
});

test("package-set publish plan is platform-first, main-last, and idempotent", () => {
  const plan = planPackageSetPublish({
    mainPackage: "@kungfu-systems/libnode",
    distTag: "alpha",
    packages: [
      {
        name: "@kungfu-systems/libnode",
        version: "22.22.3-kf.0",
        role: "main",
        integrity: "sha-main",
      },
      {
        name: "@kungfu-systems/libnode-linux-x64",
        version: "22.22.3-kf.0",
        role: "platform",
        integrity: "sha-linux",
      },
      {
        name: "@kungfu-systems/libnode-darwin-arm64",
        version: "22.22.3-kf.0",
        role: "platform",
        integrity: "sha-macos",
      },
    ],
    existingPackages: [
      {
        name: "@kungfu-systems/libnode-linux-x64",
        version: "22.22.3-kf.0",
        integrity: "sha-linux",
      },
    ],
  });
  assert.deepEqual(
    plan.steps.map((step) => `${step.action}:${step.package.name}`),
    [
      "accept-existing:@kungfu-systems/libnode-linux-x64",
      "publish:@kungfu-systems/libnode-darwin-arm64",
      "publish:@kungfu-systems/libnode",
    ],
  );
  assert.equal(plan.visibilityGate, "main-package-last");
  assert.equal(plan.distTagMove.package.name, "@kungfu-systems/libnode");
  assert.throws(
    () =>
      planPackageSetPublish({
        packages: [
          { name: "main", version: "1.0.0", role: "main", integrity: "a" },
          { name: "platform", version: "1.0.0", integrity: "b" },
        ],
        existingPackages: [
          { name: "platform", version: "1.0.0", integrity: "different" },
        ],
      }),
    /integrity mismatch/,
  );
});

test("expected artifact JSON normalizes supported checks", () => {
  assert.deepEqual(
    parseExpectedArtifactsJson(
      '{"minFiles":2,"maxFiles":5,"minTotalBytes":1,"requiredPaths":["dist/a.txt"]}',
    ),
    {
      minFiles: 2,
      maxFiles: 5,
      minTotalBytes: 1,
      requiredPaths: ["dist/a.txt"],
    },
  );
});

test("buildchain semver version state includes generated site contract version", () => {
  const summary = validateBuildchainConfig(root, {
    requireVersionState: true,
    requireLifecycleStages: ["install", "verify", "publish"],
  });
  assert.deepEqual(
    summary.versionFiles.map((file) => `${file.path}#${file.key}`),
    [
      "package.json#version",
      ".buildchain/release-impact.json#release.version",
      "dist/site/buildchain-contract.json#product.version",
      "dist/site/buildchain-site.json#package.version",
      "dist/site/site-manifest.json#package.version",
      "dist/site/publication-registry.json#package.version",
      "dist/site/kfd-upstream-aggregate.json#product.version",
    ],
  );
  assert.ok(
    summary.lifecycleStages.some((stage) => stage.name === "version-state"),
  );
  const versionFiles = discoverConfiguredVersionStateFiles(root, loadBuildchainConfig(root));
  const currentImpact = JSON.parse(fs.readFileSync(path.join(root, ".buildchain/release-impact.json"), "utf8"));
  const currentVersion = String(currentImpact.release.version);
  const currentMatch = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  assert.ok(currentMatch);
  const nextVersion = `${currentMatch[1]}.${currentMatch[2]}.${Number(currentMatch[3]) + 1}-alpha.0`;
  const updated = updateConfiguredVersionStateContents(versionFiles, nextVersion);
  const releaseImpact = JSON.parse(
    updated.find((file) => file.path === ".buildchain/release-impact.json").content,
  );
  assert.equal(releaseImpact.release.version, nextVersion);
  assert.equal(releaseImpact.release.line, `v${currentMatch[1]}.${currentMatch[2]}`);
});

test("generated release model publishes the generic major alpha channel contract", () => {
  const releaseModel = JSON.parse(
    fs.readFileSync(path.join(root, "dist/site/release-model.json"), "utf8"),
  );
  assert.match(releaseModel.floatingTags, /vX-alpha/);
  assert.match(releaseModel.floatingTags, /highest minor in major X with a published alpha/);
});

test("Buildchain self-dogfoods through the public alpha train without weakening exact runtime resolution", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-alpha-self-dogfood.yml"),
    "utf8",
  );
  const promotion = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-ref-promotion.yml"),
    "utf8",
  );

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \["Buildchain Ref Promotion"\]/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /permissions:\n  actions: read\n  contents: read/);
  assert.equal(
    workflow.match(/^\s{6}actions: read$/gmu)?.length,
    2,
    "both self-dogfood reusable-workflow call jobs must propagate artifact read permission",
  );
  assert.match(workflow, /group: buildchain-release-promotion-\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /build\.yml@v3-alpha/);
  assert.match(workflow, /buildchain-channel: auto/);
  assert.match(workflow, /buildchain-channel: stable/);
  assert.match(workflow, /ALPHA_RUNTIME_SHA: \$\{\{ needs\.alpha-consumer\.outputs\.buildchain-runtime-sha \}\}/);
  assert.match(workflow, /STABLE_RUNTIME_SHA: \$\{\{ needs\.stable-consumer\.outputs\.buildchain-runtime-sha \}\}/);
  assert.match(workflow, /ref: `tags\/\$\{tag\}`/);
  assert.match(workflow, /kungfu-buildchain-alpha-self-dogfood/);
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
  assert.doesNotMatch(workflow, /buildchain-ref:/);
  assert.doesNotMatch(workflow, /\.build\.yml@v3\n/);
  assert.doesNotMatch(workflow, /buildchain-contract-lock-path:/);

  const alphaLock = JSON.parse(
    fs.readFileSync(path.join(root, ".buildchain/alpha-contract-lock.json"), "utf8"),
  );
  const stableLock = JSON.parse(
    fs.readFileSync(path.join(root, ".buildchain/contract-lock.json"), "utf8"),
  );
  const currentContract = JSON.parse(
    fs.readFileSync(path.join(root, "dist/site/buildchain-contract.json"), "utf8"),
  );
  assert.equal(alphaLock.buildchain.ref, "v3-alpha");
  assert.equal(alphaLock.buildchain.resolvedSha, "85b4b69c3a76f3e64e8e96d8357d87cac62c9f16");
  assert.equal(alphaLock.buildchain.compatibilityPolicy, "major-compatible");
  assert.equal(stableLock.buildchain.ref, "v3");
  assert.equal(stableLock.buildchain.resolvedSha, "9e904de2c85dbea7c799780ee166510b3336d812");
  assert.equal(stableLock.buildchain.majorLine, "v3");
  assert.equal(stableLock.buildchain.compatibilityPolicy, "major-compatible");
  assert.match(alphaLock.buildchain.compatibilityDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(currentContract.compatibilityDigest, /^sha256:[0-9a-f]{64}$/u);
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  const majorResolution = resolveSelfDogfoodMajor({
    packageVersion,
    alphaRef: alphaLock.buildchain.ref,
    majorBootstrap: process.env.BUILDCHAIN_MAJOR_VERSION_BOOTSTRAP === "true",
  });
  const alphaEvaluation = evaluateBuildchainContractLock({
    lock: alphaLock,
    current: contractForSelfDogfoodEvaluation({
      currentContract,
      majorResolution,
    }),
    runtimeRef: "v3-alpha",
    runtimeSha: "current-development-contract",
    runtimeClass: "alpha",
  });
  assert.equal(
    canAdmitSelfDogfoodLockEvaluation({
      evaluation: alphaEvaluation,
      majorResolution,
    }),
    true,
  );
  if (!majorResolution.bootstrap) {
    assert.equal(alphaEvaluation.compatible, true);
  }

  const reusableBuild = fs.readFileSync(
    path.join(root, ".github/workflows/.build.yml"),
    "utf8",
  );
  assert.match(reusableBuild, /BUILDCHAIN_WORKFLOW_REF: \$\{\{ job\.workflow_ref \}\}/);
  assert.match(reusableBuild, /process\.env\.BUILDCHAIN_WORKFLOW_REF \|\| process\.env\.GITHUB_WORKFLOW_REF/);
  assert.match(reusableBuild, /replace\(\/\^refs\\\/\(\?:heads\|tags\)\\\/\//);

  const actionlintConfig = fs.readFileSync(
    path.join(root, ".github/actionlint.yaml"),
    "utf8",
  );
  assert.match(actionlintConfig, /\.github\/workflows\/\.build\.yml:/);
  assert.match(actionlintConfig, /\.github\/workflows\/build\.yml:/);
  assert.match(actionlintConfig, /property "workflow_ref" is not defined in object type/);
  assert.match(actionlintConfig, /property "workflow_repository" is not defined in object type/);
  assert.match(actionlintConfig, /property "workflow_sha" is not defined in object type/);

  assert.match(
    promotion,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/release-candidate-promote\.yml@9a0cdf8d84aacf8c7daaac82efa43d1b34696a03/,
  );
  assert.match(promotion, /buildchain-ref: 9a0cdf8d84aacf8c7daaac82efa43d1b34696a03/);
  assert.doesNotMatch(promotion, /uses: \.\/\.github\/workflows\/\.release-candidate-promote\.yml/);
});

test("major self-dogfood bootstrap is bounded to the adjacent 0.0 release transition", () => {
  assert.deepEqual(
    resolveSelfDogfoodMajor({
      packageVersion: "2.14.18-alpha.5",
      alphaRef: "v2-alpha",
    }),
    { packageMajor: 2, workflowMajor: 2, bootstrap: false },
  );
  assert.deepEqual(
    resolveSelfDogfoodMajor({
      packageVersion: "3.0.0",
      alphaRef: "v2-alpha",
      majorBootstrap: true,
    }),
    { packageMajor: 3, workflowMajor: 2, bootstrap: true },
  );
  assert.deepEqual(
    resolveSelfDogfoodMajor({
      packageVersion: "3.0.1-alpha.0",
      alphaRef: "v2-alpha",
      majorBootstrap: true,
    }),
    { packageMajor: 3, workflowMajor: 2, bootstrap: true },
  );
  for (const input of [
    { packageVersion: "3.0.0", alphaRef: "v2-alpha" },
    {
      packageVersion: "3.0.1",
      alphaRef: "v2-alpha",
      majorBootstrap: true,
    },
    {
      packageVersion: "3.0.2-alpha.0",
      alphaRef: "v2-alpha",
      majorBootstrap: true,
    },
    {
      packageVersion: "4.0.0",
      alphaRef: "v2-alpha",
      majorBootstrap: true,
    },
  ]) {
    assert.throws(
      () => resolveSelfDogfoodMajor(input),
      /must target the current major alpha ref/,
    );
  }

  const alphaLock = JSON.parse(
    fs.readFileSync(path.join(root, ".buildchain/alpha-contract-lock.json"), "utf8"),
  );
  const currentContract = JSON.parse(
    fs.readFileSync(path.join(root, "dist/site/buildchain-contract.json"), "utf8"),
  );
  const majorResolution = resolveSelfDogfoodMajor({
    packageVersion: "4.0.0",
    alphaRef: "v3-alpha",
    majorBootstrap: true,
  });
  const nextMajorContract = { ...currentContract, majorLine: "v4" };
  const bootstrapContract = contractForSelfDogfoodEvaluation({
    currentContract: nextMajorContract,
    majorResolution,
  });
  assert.equal(bootstrapContract.majorLine, "v3");
  assert.equal(nextMajorContract.majorLine, "v4");
  const bootstrapEvaluation = evaluateBuildchainContractLock({
    lock: alphaLock,
    current: bootstrapContract,
    runtimeRef: "v3-alpha",
    runtimeSha: "current-development-contract",
    runtimeClass: "alpha",
  });
  assert.equal(
    canAdmitSelfDogfoodLockEvaluation({
      evaluation: bootstrapEvaluation,
      majorResolution,
    }),
    true,
  );
  if (process.env.BUILDCHAIN_MAJOR_VERSION_BOOTSTRAP !== "true") {
    assert.equal(bootstrapEvaluation.compatible, true);
  }
  const breakingContract = structuredClone(bootstrapContract);
  breakingContract.surfaces[0].breakingDigest = "sha256:breaking-bootstrap-drift";
  const breakingEvaluation = evaluateBuildchainContractLock({
    lock: alphaLock,
    current: breakingContract,
    runtimeRef: "v3-alpha",
    runtimeSha: "current-development-contract",
    runtimeClass: "alpha",
  });
  assert.equal(breakingEvaluation.compatible, false);
  assert.equal(
    canAdmitSelfDogfoodLockEvaluation({
      evaluation: breakingEvaluation,
      majorResolution,
    }),
    true,
  );
  assert.equal(
    canAdmitSelfDogfoodLockEvaluation({
      evaluation: breakingEvaluation,
      majorResolution: { ...majorResolution, bootstrap: false },
    }),
    false,
  );
});

test("libnode-shaped fixture declares the build lifecycle contract", () => {
  const fixture = path.join(root, "fixtures/libnode-shaped");
  const summary = validateBuildchainConfig(fixture, {
    requireVersionState: true,
    requireLifecycleStages: ["install", "build", "verify"],
  });
  assert.deepEqual(
    summary.versionFiles.map((file) => file.path),
    ["package.json"],
  );
  assert.deepEqual(
    summary.lifecycleStages.map((stage) => stage.name),
    ["install", "build", "verify", "publish"],
  );
});

test("runLifecycle binds compiler-cache activity verification to the runtime action", () => {
  const events = [];
  let verificationOptions;
  const activity = verifyBuildLifecycleCompilerCacheActivity({
    stageName: "build",
    executed: true,
    cwd: "/consumer",
    env: { BUILDCHAIN_COMPILER_CACHE_REQUIRED: "true" },
    verifier: (options) => {
      verificationOptions = options;
      return {
        compileRequests: 12,
        cacheHits: 7,
        cacheMisses: 5,
        cacheableRequests: 12,
      };
    },
    frameworkLog: {
      info: (event, payload) => events.push({ event, payload }),
    },
  });

  assert.deepEqual(verificationOptions, {
    cwd: "/consumer",
    env: { BUILDCHAIN_COMPILER_CACHE_REQUIRED: "true" },
  });
  assert.deepEqual(activity, {
    compileRequests: 12,
    cacheHits: 7,
    cacheMisses: 5,
    cacheableRequests: 12,
  });
  assert.deepEqual(events, [
    {
      event: "compiler-cache.activity",
      payload: { attributes: activity },
    },
  ]);
  assert.equal(
    verifyBuildLifecycleCompilerCacheActivity({
      stageName: "verify",
      executed: true,
      verifier: () => assert.fail("non-build lifecycle must not verify cache activity"),
    }),
    undefined,
  );
});

test("runLifecycle writes deterministic artifact manifest", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-surface-"),
  );
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixtures/libnode-shaped");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  const originalEnv = { ...process.env };
  try {
    process.env.GITHUB_SHA = "1".repeat(40);
    process.env.GITHUB_REF = "refs/heads/dev/v2/v2.0";
    process.env.BUILDCHAIN_SOURCE_SHA = "2".repeat(40);
    process.env.BUILDCHAIN_SOURCE_REF =
      "publish-gate/release/v22/v22.22/22.22.3-kf.0";
    const processSummaryPath = path.join(workspace, ".buildchain/diagnostics/process-summary.json");
    const processSamplesPath = path.join(workspace, ".buildchain/diagnostics/process-samples.jsonl");
    fs.mkdirSync(path.dirname(processSummaryPath), { recursive: true });
    fs.writeFileSync(processSamplesPath, `${JSON.stringify({
      timestamp: "2026-07-02T00:00:00.000Z",
      processes: [{ command: "clang++", cpu: 25 }],
    })}\n`);
    fs.writeFileSync(processSummaryPath, `${JSON.stringify({
      schemaVersion: 1,
      contract: BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
      samplesPath: ".buildchain/diagnostics/process-samples.jsonl",
      summary: {
        schemaVersion: 1,
        contract: BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
        requestedParallelism: 8,
        requestedParallelismSource: "explicit",
        observedConcurrency: { max: 3, ratioToRequestedMax: 0.375 },
        sampleCount: 1,
        categories: { compiler: 2, "build-tool": 1 },
        topCommands: [{ command: "clang++", count: 2 }],
      },
    })}\n`);
    fs.writeFileSync(path.join(workspace, ".buildchain/diagnostics/source-checkout.json"), `${JSON.stringify({
      schemaVersion: 1,
      contract: "kungfu-buildchain-locked-source-checkout-cache",
      policy: { mode: "auto", fallback: "github" },
      cache: { transport: "mirror-url", hit: true, fallbackUsed: false, fallbackReason: "" },
      verification: { head: "2".repeat(40), tree: "3".repeat(40), headOk: true, treeOk: true },
      durationMs: 123,
    })}\n`);
    fs.writeFileSync(
      path.join(workspace, ".buildchain/diagnostics/compiler-cache-preparation.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        contract: "kungfu-buildchain-compiler-cache-preparation",
        provider: "sccache",
        status: "prepared",
        action: { statsReset: true },
        root: `sha256:${"4".repeat(64)}`,
      })}\n`,
    );
    runLifecycle({
      cwd: fixture,
      stageName: "install",
      required: true,
      workspace,
    });
    runLifecycle({
      cwd: fixture,
      stageName: "build",
      required: true,
      workspace,
      artifactPaths: ["fixtures/libnode-shaped/dist"],
      manifestPath: ".buildchain/artifacts/linux-x64/manifest.json",
      artifactName: "libnode-shaped-linux-x64-abc123",
      platformId: "linux-x64",
      platformName: "Linux x64",
      processSummaryPath: ".buildchain/diagnostics/process-summary.json",
    });
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/manifest.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.contract, "kungfu-buildchain-artifact");
    assert.equal(manifest.artifactName, "libnode-shaped-linux-x64-abc123");
    assert.equal(manifest.platform.id, "linux-x64");
    assert.equal(manifest.git.sha, "2".repeat(40));
    assert.equal(
      manifest.git.ref,
      "publish-gate/release/v22/v22.22/22.22.3-kf.0",
    );
    assert.equal(
      manifest.summary.contract,
      "kungfu-buildchain-artifact-summary",
    );
    assert.equal(manifest.summary.fileCount, 2);
    assert.ok(manifest.summary.totalBytes > 0);
    assert.ok(manifest.observability.lifecycle.stages.install);
    assert.ok(manifest.observability.lifecycle.stages.build);
    assert.equal(
      manifest.observability.diagnostics.path,
      ".buildchain/artifacts/linux-x64/diagnostics.json",
    );
    assert.equal(
      manifest.observability.diagnostics.manifestPath,
      ".buildchain/artifacts/linux-x64/diagnostics-manifest.json",
    );
    assert.equal(manifest.expectedArtifacts.ok, true);
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      [
        "fixtures/libnode-shaped/dist/install.txt",
        "fixtures/libnode-shaped/dist/libnode-shaped.txt",
      ],
    );
    assert.ok(
      manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
    );
    const diagnostics = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics.json"),
        "utf8",
      ),
    );
    assert.equal(diagnostics.contract, "kungfu-buildchain-diagnostics");
    assert.equal(diagnostics.lifecycleObservability.stages.install.eventCount > 0, true);
    assert.equal(diagnostics.lifecycleObservability.stages.build.eventCount > 0, true);
    assert.equal(diagnostics.native.enabled, true);
    assert.equal(diagnostics.native.profile.sampleProcessTree, true);
    assert.equal(diagnostics.native.profile.compilerCache, "auto");
    assert.deepEqual(
      diagnostics.native.profile.expectedTools,
      ["node", "pnpm", "git", "cmake", "ninja", "ccache", "sccache"],
    );
    assert.deepEqual(
      diagnostics.buildchain.config.diagnostics.native.artifactDirs,
      ["dist", "build"],
    );
    assert.equal(diagnostics.native.artifactDirs[0].path, "dist");
    assert.equal(diagnostics.native.artifactDirs[0].exists, true);
    assert.equal(diagnostics.native.artifactDirs[1].path, "build");
    assert.equal(diagnostics.native.artifactDirs[1].exists, false);
    assert.equal(diagnostics.native.cacheDirs[0].path, ".ccache");
    assert.equal(diagnostics.native.cacheDirs[0].exists, false);
    assert.equal(diagnostics.nativeCacheDirs[0].path, ".ccache");
    assert.ok(diagnostics.compilerCaches.ccache);
    assert.equal(diagnostics.process.requestedParallelism, 8);
    assert.equal(diagnostics.process.observedConcurrency.max, 3);
    assert.equal(diagnostics.sourceCheckout.contract, "kungfu-buildchain-locked-source-checkout-cache");
    assert.equal(diagnostics.sourceCheckout.cache.hit, true);
    assert.equal(diagnostics.sourceCheckout.verification.headOk, true);
    assert.equal(diagnostics.links.artifactName, "libnode-shaped-linux-x64-abc123");
    assert.equal(diagnostics.links.platformId, "linux-x64");
    assert.equal(diagnostics.links.processSummary, ".buildchain/diagnostics/process-summary.json");
    assert.equal(diagnostics.links.diagnosticsManifest, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json");
    assert.equal(diagnostics.links.diagnosticsEvents, ".buildchain/artifacts/linux-x64/events.jsonl");
    assert.equal(diagnostics.links.diagnosticsProcessSummary, ".buildchain/artifacts/linux-x64/process-summary.json");
    assert.equal(diagnostics.links.diagnosticsProcessSamples, ".buildchain/artifacts/linux-x64/process-samples.jsonl");
    assert.equal(diagnostics.links.sourceCheckout, ".buildchain/artifacts/linux-x64/source-checkout.json");
    assert.equal(
      diagnostics.links.compilerCachePreparation,
      ".buildchain/artifacts/linux-x64/compiler-cache-preparation.json",
    );
    const diagnosticsManifest = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json"),
        "utf8",
      ),
    );
    assert.equal(diagnosticsManifest.contract, BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT);
    assert.equal(diagnosticsManifest.artifactName, "libnode-shaped-linux-x64-abc123");
    assert.equal(diagnosticsManifest.platformId, "linux-x64");
    assert.equal(diagnosticsManifest.fileCount, 6);
    assert.deepEqual(
      diagnosticsManifest.files.map((file) => file.kind),
      [
        "diagnostics",
        "events",
        "process-summary",
        "process-samples",
        "source-checkout",
        "compiler-cache-preparation",
      ],
    );
    assert.ok(diagnosticsManifest.files.every((file) => file.bytes > 0));
    assert.ok(diagnosticsManifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.equal(
      diagnosticsManifest.files.find((file) => file.kind === "diagnostics").path,
      ".buildchain/artifacts/linux-x64/diagnostics.json",
    );
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/artifacts/linux-x64/events.jsonl")));
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json")));
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/artifacts/linux-x64/process-summary.json")));
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/artifacts/linux-x64/process-samples.jsonl")));
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/artifacts/linux-x64/source-checkout.json")));
    assert.ok(
      fs.existsSync(
        path.join(
          workspace,
          ".buildchain/artifacts/linux-x64/compiler-cache-preparation.json",
        ),
      ),
    );
  } finally {
    process.env = originalEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runLifecycle binds platform signing declarations outside upload paths", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-signing-lifecycle-"),
  );
  try {
    const consumer = path.join(workspace, "consumer");
    const releaseArtifact = path.join(consumer, "release", "checksums.txt");
    const frameworkBinary = path.join(
      consumer,
      "dist",
      "Kungfu Episodes.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Electron Framework",
    );
    fs.mkdirSync(path.dirname(releaseArtifact), { recursive: true });
    fs.mkdirSync(path.dirname(frameworkBinary), { recursive: true });
    fs.writeFileSync(releaseArtifact, "release\n");
    fs.writeFileSync(frameworkBinary, "nested-native-code\n");
    fs.writeFileSync(
      path.join(consumer, "buildchain.toml"),
      `schema = 1

[[signing.artifacts]]
id = "desktop-macos-arm64"
path = "dist/Kungfu Episodes.app"
kind = "app-bundle"
platforms = ["macos-arm64"]
`,
    );

    runLifecycle({
      cwd: consumer,
      workspace,
      stageName: "build",
      platformId: "macos-arm64",
      artifactPaths: ["consumer/release"],
      manifestPath: ".buildchain/artifacts/macos-arm64/manifest.json",
    });
    const macManifest = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/macos-arm64/manifest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      macManifest.files.map((entry) => entry.path),
      [
        "consumer/dist/Kungfu Episodes.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
        "consumer/release/checksums.txt",
      ],
    );

    runLifecycle({
      cwd: consumer,
      workspace,
      stageName: "build",
      platformId: "linux-x64",
      artifactPaths: ["consumer/release"],
      manifestPath: ".buildchain/artifacts/linux-x64/manifest.json",
    });
    const linuxManifest = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/manifest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      linuxManifest.files.map((entry) => entry.path),
      ["consumer/release/checksums.txt"],
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runLifecycle command override inherits declared stage shell and lifecycle env", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-command-override-"));
  const fixture = path.join(workspace, "fixture");
  fs.cpSync(path.join(root, "fixtures/libnode-shaped"), fixture, { recursive: true });
  const configPath = path.join(fixture, "buildchain.toml");
  fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8")
    .replace('[lifecycle.verify]\ncommand = "node scripts/verify.mjs"', '[lifecycle.verify]\ncommand = "node scripts/verify.mjs"\nshell = "/bin/bash"\n\n[lifecycle.verify.env]\nBUILDCHAIN_STAGE_ENV = "stage-value"')
    .replace("[lifecycle.install]", '[lifecycle.env]\nBUILDCHAIN_SHARED_ENV = "shared-value"\n\n[lifecycle.install]'));
  try {
    runLifecycle({
      cwd: fixture,
      stageName: "verify",
      command: 'printf "%s\\n%s\\n%s\\n" "$0" "$BUILDCHAIN_SHARED_ENV" "$BUILDCHAIN_STAGE_ENV" > command-override.txt',
      required: true,
      workspace,
    });
    assert.deepEqual(fs.readFileSync(path.join(fixture, "command-override.txt"), "utf8").trim().split("\n"), ["/bin/bash", "shared-value", "stage-value"]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runLifecycle applies a clear fallback timeout to commands and configured stages", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-lifecycle-timeout-"));
  const fixture = path.join(workspace, "fixture");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "buildchain.toml"),
    'schema = 1\n\n[lifecycle.verify]\ncommand = "node -e \\\"setTimeout(() => {}, 1000)\\\""\n',
  );
  try {
    assert.throws(
      () => runLifecycle({
        cwd: fixture,
        stageName: "verify",
        command: 'node -e "setTimeout(() => {}, 1000)"',
        timeoutMinutes: 0.001,
        platformId: "linux-x64",
        platformName: "Linux x64",
        workspace,
      }),
      /lifecycle verify timed out after 0\.001 minute\(s\) on Linux x64 \(linux-x64\)/,
    );
    assert.throws(
      () => runLifecycle({
        cwd: fixture,
        stageName: "verify",
        timeoutMinutes: 0.001,
        platformId: "linux-x64",
        platformName: "Linux x64",
        workspace,
      }),
      /lifecycle verify timed out after 0\.001 minute\(s\) on Linux x64 \(linux-x64\)/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("reusable build bounds matrix jobs and lifecycle actions with one timeout input", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  const action = fs.readFileSync(path.join(root, "actions/run-lifecycle/action.yml"), "utf8");

  assert.match(workflow, /lifecycle-timeout-minutes:[\s\S]*?default: 120[\s\S]*?type: number/);
  assert.equal(
    (workflow.match(/timeout-minutes: \$\{\{ inputs\.lifecycle-timeout-minutes \}\}/g) || []).length,
    8,
  );
  assert.match(action, /timeout-minutes:[\s\S]*?default: "120"/);
});

test("signed platform metadata artifacts exclude imported payload trees", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  const stepBlock = (name) => {
    const start = workflow.indexOf(`      - name: ${name}`);
    assert.notEqual(start, -1, `missing workflow step: ${name}`);
    const next = workflow.indexOf("\n      - name:", start + 1);
    return workflow.slice(start, next === -1 ? workflow.length : next);
  };

  assert.doesNotMatch(
    stepBlock("Publish final signed artifact manifest"),
    /\.buildchain\/artifacts\/signing/,
  );
  assert.doesNotMatch(
    stepBlock("Publish final signed diagnostics"),
    /\.buildchain\/artifacts\/signing/,
  );
  assert.match(
    workflow,
    /\$\{\{ inputs\.artifact-name \}\}-credential-manifest-macos-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/,
  );
  assert.match(
    workflow,
    /\$\{BUILDCHAIN_ARTIFACT_NAME\}-credential-manifest-macos-\$\{BUILDCHAIN_SOURCE_SHA\}/,
  );
  assert.doesNotMatch(workflow, /-manifest-macos-credential-/);
});

test("runLifecycle samples a configured lifecycle stage", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-sampled-lifecycle-"),
  );
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixtures/libnode-shaped");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  try {
    runLifecycle({
      cwd: fixture,
      stageName: "install",
      required: true,
      workspace,
    });
    runLifecycle({
      cwd: fixture,
      stageName: "build",
      required: true,
      workspace,
      artifactPaths: ["fixtures/libnode-shaped/dist"],
      manifestPath: ".buildchain/artifacts/linux-x64/manifest-sampled.json",
      summaryPath: ".buildchain/artifacts/linux-x64/summary-sampled.json",
      diagnosticsPath: ".buildchain/artifacts/linux-x64/diagnostics-sampled.json",
      artifactName: "libnode-shaped-linux-x64-sampled",
      platformId: "linux-x64",
      platformName: "Linux x64",
      processSummaryPath: ".buildchain/diagnostics/process-summary.json",
      processSamplesPath: ".buildchain/diagnostics/process-samples.jsonl",
      sampleProcessTree: true,
      processSampleIntervalMs: 1000,
      requestedParallelism: 4,
    });

    const processSummary = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/diagnostics/process-summary.json"),
        "utf8",
      ),
    );
    const diagnostics = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics-sampled.json"),
        "utf8",
      ),
    );
    assert.equal(processSummary.contract, BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT);
    assert.equal(processSummary.summary.requestedParallelism, 4);
    assert.ok(processSummary.summary.sampleCount >= 1);
    assert.equal(diagnostics.process.requestedParallelism, 4);
    assert.equal(diagnostics.links.processSummary, ".buildchain/diagnostics/process-summary.json");
    assert.equal(diagnostics.links.diagnosticsManifest, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json");
    assert.equal(diagnostics.links.diagnosticsProcessSummary, ".buildchain/artifacts/linux-x64/process-summary.json");
    assert.equal(diagnostics.links.diagnosticsProcessSamples, ".buildchain/artifacts/linux-x64/process-samples.jsonl");
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/diagnostics/process-samples.jsonl")));
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json")));
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/artifacts/linux-x64/process-summary.json")));
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/artifacts/linux-x64/process-samples.jsonl")));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runLifecycle records sampled command failure evidence", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-sampled-lifecycle-failure-"),
  );
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixtures/libnode-shaped");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  try {
    assert.throws(
      () => runLifecycle({
        cwd: fixture,
        command: [
          JSON.stringify(process.execPath),
          "-e",
          JSON.stringify("console.log('wrapped stdout marker'); console.error('wrapped stderr marker'); process.exit(7);"),
        ].join(" "),
        required: true,
        workspace,
        logPath: ".buildchain/logs/failing-lifecycle.jsonl",
        processSummaryPath: ".buildchain/diagnostics/failing-process-summary.json",
        processSamplesPath: ".buildchain/diagnostics/failing-process-samples.jsonl",
        sampleProcessTree: true,
        processSampleIntervalMs: 1000,
      }),
      (error) => error.status === 7,
    );

    const processSummary = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/diagnostics/failing-process-summary.json"),
        "utf8",
      ),
    );
    assert.equal(processSummary.wrappedCommand.exitCode, 7);
    assert.match(processSummary.wrappedCommand.stdoutTail, /wrapped stdout marker/);
    assert.match(processSummary.wrappedCommand.stderrTail, /wrapped stderr marker/);

    const events = fs.readFileSync(
      path.join(workspace, ".buildchain/logs/failing-lifecycle.jsonl"),
      "utf8",
    ).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const errorEvent = events.find((event) => event.event === "lifecycle.command.error");
    assert.ok(errorEvent);
    assert.equal(errorEvent.attributes.status, 7);
    assert.match(errorEvent.attributes.stdoutTail, /wrapped stdout marker/);
    assert.match(errorEvent.attributes.stderrTail, /wrapped stderr marker/);
    assert.equal(errorEvent.attributes.wrappedCommandExitCode, 7);
    assert.equal(JSON.parse(errorEvent.attributes.wrappedCommand).exitCode, 7);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runLifecycle can treat a missing process summary as optional", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-optional-process-summary-"),
  );
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixtures/libnode-shaped");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  try {
    runLifecycle({
      cwd: fixture,
      command: 'node -e "console.log(\'optional process summary smoke\')"',
      required: true,
      workspace,
      artifactPaths: ["fixtures/libnode-shaped/dist"],
      manifestPath: ".buildchain/artifacts/linux-x64/manifest-optional-process.json",
      diagnosticsPath: ".buildchain/artifacts/linux-x64/diagnostics-optional-process.json",
      processSummaryPath: ".buildchain/diagnostics/missing-process-summary.json",
      processSummaryRequired: false,
    });
    const diagnostics = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics-optional-process.json"),
        "utf8",
      ),
    );
    assert.equal(diagnostics.process.sampleCount, 0);
    assert.equal(diagnostics.links.processSummary, ".buildchain/diagnostics/missing-process-summary.json");
    assert.equal(diagnostics.links.diagnosticsProcessSummary, undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("aggregate build summary reads uploaded platform manifests", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-summary-"),
  );
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixtures/libnode-shaped");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  const originalEnv = { ...process.env };
  try {
    runLifecycle({
      cwd: fixture,
      stageName: "install",
      required: true,
      workspace,
    });
    runLifecycle({
      cwd: fixture,
      stageName: "build",
      required: true,
      workspace,
      artifactPaths: ["fixtures/libnode-shaped/dist"],
      manifestPath:
        ".buildchain/uploaded/libnode-manifest-linux-x64-sha/manifest.json",
      summaryPath:
        ".buildchain/uploaded/libnode-manifest-linux-x64-sha/summary.json",
      artifactName: "libnode-linux-x64-sha",
      platformId: "linux-x64",
      platformName: "Linux x64",
      expectedArtifactsJson:
        '{"minFiles":2,"requiredPaths":["fixtures/libnode-shaped/dist/install.txt","fixtures/libnode-shaped/dist/libnode-shaped.txt"]}',
    });

    process.env.BUILDCHAIN_SUMMARY_INPUT = path.join(
      workspace,
      ".buildchain/uploaded",
    );
    process.env.BUILDCHAIN_SUMMARY_OUTPUT = path.join(
      workspace,
      ".buildchain/artifacts/build-summary.json",
    );
    process.env.BUILDCHAIN_ARTIFACT_NAME = "libnode";
    process.env.BUILDCHAIN_PLATFORM_COUNT = "1";
    process.env.BUILDCHAIN_EXPECTED_PLATFORMS_JSON = '[{"id":"linux-x64"}]';
    process.env.BUILDCHAIN_ADDITIONAL_PLATFORM_COUNT = "0";
    process.env.BUILDCHAIN_ADDITIONAL_PLATFORM_IDS_JSON = "[]";
    process.env.BUILDCHAIN_TRUSTED_EVENT = "true";
    process.env.BUILDCHAIN_PUBLISH_CHANNEL = "release";
    process.env.BUILDCHAIN_PUBLISH_ALLOWED = "true";
    process.env.BUILDCHAIN_PUBLISH_REASON = "ref matched release";
    process.env.BUILDCHAIN_PUBLISH_SOURCE_REF =
      "publish-gate/release/v22/v22.22/22.22.3-kf.0";
    process.env.BUILDCHAIN_PUBLISH_SOURCE_SHA = "e".repeat(40);
    process.env.BUILDCHAIN_PUBLISH_SOURCE_LOCKED = "true";
    process.env.BUILDCHAIN_PUBLISH_SOURCE_CHANNEL = "release";
    process.env.BUILDCHAIN_PUBLISH_SOURCE_LINE = "v22/v22.22";
    process.env.BUILDCHAIN_PUBLISH_SOURCE_CONSUMER_VERSION = "22.22.3-kf.0";
    process.env.BUILDCHAIN_RELEASE_MANIFEST_JSON = '{"schema":1}';
    process.env.BUILDCHAIN_SOURCE_SHA = "e".repeat(40);
    process.env.BUILDCHAIN_SOURCE_TREE_SHA = "tree-e";
    process.env.BUILDCHAIN_SOURCE_REF =
      "publish-gate/release/v22/v22.22/22.22.3-kf.0";
    process.env.GITHUB_SHA = "f".repeat(40);
    process.env.GITHUB_OUTPUT = path.join(workspace, "github-output.txt");
    const summary = aggregateBuildSummaryCli();

    assert.equal(summary.contract, "kungfu-buildchain-build-summary");
    assert.equal(summary.git.sha, "e".repeat(40));
    assert.equal(summary.git.treeSha, "tree-e");
    assert.equal(
      summary.git.ref,
      "publish-gate/release/v22/v22.22/22.22.3-kf.0",
    );
    assert.equal(summary.platformCount, 1);
    assert.equal(summary.fileCount, 2);
    assert.ok(summary.totalBytes > 0);
    assert.ok(summary.observability.lifecycle.stages.install);
    assert.ok(summary.observability.lifecycle.stages.build);
    assert.deepEqual(summary.publishGate, {
      trustedEvent: true,
      channel: "release",
      allowed: true,
      reason: "ref matched release",
    });
    assert.deepEqual(summary.publishSource, {
      ref: "publish-gate/release/v22/v22.22/22.22.3-kf.0",
      sha: "e".repeat(40),
      locked: true,
      channel: "release",
      line: "v22/v22.22",
      consumerVersion: "22.22.3-kf.0",
      releaseManifest: '{"schema":1}',
    });
    assert.equal(summary.platforms[0].artifactName, "libnode-linux-x64-sha");
    assert.ok(summary.platforms[0].observability.lifecycle.stages.build);
    assert.equal(summary.platforms[0].expectedArtifacts.ok, true);
  } finally {
    process.env = originalEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("aggregate build summary selects only controller-declared platform manifests", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-summary-selection-"));
  const originalEnv = { ...process.env };
  try {
    const inputRoot = path.join(workspace, ".buildchain/downloaded-manifests");
    const writeManifest = (relativePath, platformId, artifactName = `kungfu-${platformId}`) => {
      const target = path.join(inputRoot, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify({
        schemaVersion: 1,
        contract: "kungfu-buildchain-artifact",
        artifactName,
        platform: { id: platformId, name: platformId },
        summary: { fileCount: 1, totalBytes: 32 },
        expectedArtifacts: { ok: true },
      }, null, 2)}\n`);
    };
    writeManifest("kungfu-manifest-linux-x64-sha/manifest.json", "linux-x64");
    writeManifest("kungfu-manifest-macos-arm64-sha/macos-arm64/manifest.json", "macos-arm64");
    writeManifest(
      "kungfu-manifest-macos-credential-sha/manifest.json",
      "macos-arm64-credential",
    );
    writeManifest(
      "kungfu-manifest-macos-arm64-sha/signing/developer-id/manifest.json",
      "signing-evidence",
    );
    const productManifest = path.join(
      inputRoot,
      "kungfu-manifest-macos-arm64-sha/signing/product/manifest.json",
    );
    fs.mkdirSync(path.dirname(productManifest), { recursive: true });
    fs.writeFileSync(productManifest, "not a buildchain manifest\n");

    process.env.BUILDCHAIN_SUMMARY_INPUT = inputRoot;
    process.env.BUILDCHAIN_SUMMARY_OUTPUT = path.join(workspace, "build-summary.json");
    process.env.BUILDCHAIN_ARTIFACT_NAME = "kungfu";
    process.env.BUILDCHAIN_PLATFORM_COUNT = "2";
    process.env.BUILDCHAIN_EXPECTED_PLATFORMS_JSON = JSON.stringify([
      { id: "linux-x64" },
      { id: "macos-arm64" },
    ]);
    process.env.BUILDCHAIN_ADDITIONAL_PLATFORM_COUNT = "0";
    process.env.BUILDCHAIN_ADDITIONAL_PLATFORM_IDS_JSON = "[]";
    process.env.GITHUB_OUTPUT = path.join(workspace, "github-output.txt");

    const summary = aggregateBuildSummaryCli();
    assert.deepEqual(summary.platforms.map((entry) => entry.platform.id), [
      "linux-x64",
      "macos-arm64",
    ]);
    assert.equal(summary.platformCount, 2);

    process.env.BUILDCHAIN_ADDITIONAL_PLATFORM_COUNT = "1";
    process.env.BUILDCHAIN_ADDITIONAL_PLATFORM_IDS_JSON = '["macos-arm64-credential"]';
    const summaryWithCredentialIsland = aggregateBuildSummaryCli();
    assert.deepEqual(summaryWithCredentialIsland.platforms.map((entry) => entry.platform.id), [
      "linux-x64",
      "macos-arm64",
      "macos-arm64-credential",
    ]);
  } finally {
    process.env = originalEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("aggregate build summary fails closed on duplicate declared platform manifests", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-summary-duplicate-"));
  const originalEnv = { ...process.env };
  try {
    const inputRoot = path.join(workspace, "downloaded");
    for (const directory of ["first", "second"]) {
      const target = path.join(inputRoot, directory, "manifest.json");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify({
        contract: "kungfu-buildchain-artifact",
        artifactName: "kungfu-linux-x64",
        platform: { id: "linux-x64", name: "Linux x64" },
        summary: { fileCount: 1, totalBytes: 32 },
      })}\n`);
    }
    process.env.BUILDCHAIN_SUMMARY_INPUT = inputRoot;
    process.env.BUILDCHAIN_SUMMARY_OUTPUT = path.join(workspace, "summary.json");
    process.env.BUILDCHAIN_PLATFORM_COUNT = "1";
    process.env.BUILDCHAIN_EXPECTED_PLATFORMS_JSON = '[{"id":"linux-x64"}]';
    process.env.BUILDCHAIN_ADDITIONAL_PLATFORM_COUNT = "0";
    process.env.BUILDCHAIN_ADDITIONAL_PLATFORM_IDS_JSON = "[]";
    assert.throws(
      () => aggregateBuildSummaryCli(),
      /expected exactly one platform manifest for linux-x64, found 2/,
    );
  } finally {
    process.env = originalEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("aggregate diagnostics summary reads uploaded platform diagnostics", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-diagnostics-summary-"),
  );
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixtures/libnode-shaped");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  const originalEnv = { ...process.env };
  try {
    runLifecycle({
      cwd: fixture,
      stageName: "install",
      required: true,
      workspace,
    });
    runLifecycle({
      cwd: fixture,
      stageName: "build",
      required: true,
      workspace,
      artifactPaths: ["fixtures/libnode-shaped/dist"],
      manifestPath:
        ".buildchain/uploaded/libnode-diagnostics-linux-x64-sha/manifest.json",
      summaryPath:
        ".buildchain/uploaded/libnode-diagnostics-linux-x64-sha/summary.json",
      diagnosticsPath:
        ".buildchain/uploaded/libnode-diagnostics-linux-x64-sha/diagnostics.json",
      artifactName: "libnode-linux-x64-sha",
      platformId: "linux-x64",
      platformName: "Linux x64",
    });

    process.env.BUILDCHAIN_DIAGNOSTICS_INPUT = path.join(
      workspace,
      ".buildchain/uploaded",
    );
    process.env.BUILDCHAIN_DIAGNOSTICS_OUTPUT = path.join(
      workspace,
      ".buildchain/artifacts/diagnostics-summary.json",
    );
    process.env.BUILDCHAIN_PLATFORM_COUNT = "1";
    process.env.GITHUB_OUTPUT = path.join(workspace, "github-output.txt");
    const summary = aggregateDiagnosticsSummaryCli();

    assert.equal(summary.contract, BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT);
    assert.equal(summary.count, 1);
    assert.equal(summary.diagnosticsContractWarningCount, 0);
    assert.equal(summary.diagnosticsManifestWarningCount, 0);
    assert.equal(summary.platforms[0].fileCount, 2);
    assert.ok(summary.platforms[0].lifecycle.build);
    assert.equal(summary.platforms[0].diagnosticsContract.status, "verified");
    assert.equal(summary.platforms[0].diagnosticsContract.actual, BUILDCHAIN_DIAGNOSTICS_CONTRACT);
    assert.equal(summary.platforms[0].diagnosticsManifest.status, "verified");
    assert.equal(summary.platforms[0].diagnosticsManifest.fileCount, 2);
    assert.deepEqual(
      summary.platforms[0].diagnosticsManifest.files.map((file) => file.kind),
      ["diagnostics", "events"],
    );
    assert.equal(summary.platforms[0].links.artifactName, "libnode-linux-x64-sha");
    assert.equal(summary.platforms[0].links.platformId, "linux-x64");
    assert.ok(fs.existsSync(process.env.BUILDCHAIN_DIAGNOSTICS_OUTPUT));
    const outputs = fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8");
    assert.match(outputs, /diagnostics-summary-path=/);
    assert.match(outputs, /diagnostics-summary-json=/);
    const diagnosticsSummaryOutput = outputs
      .split(/\r?\n/)
      .find((line) => line.startsWith("diagnostics-summary-json="));
    assert.ok(diagnosticsSummaryOutput);
    const diagnosticsSummaryJson = JSON.parse(
      diagnosticsSummaryOutput.slice("diagnostics-summary-json=".length),
    );
    assert.equal(diagnosticsSummaryJson.diagnosticsManifestWarningCount, 0);
    assert.equal(diagnosticsSummaryJson.diagnosticsContractWarningCount, 0);
  } finally {
    process.env = originalEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("release-candidate passport validates tree-equivalent promote-only source locks", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-rc-passport-"),
  );
  try {
    const manifestDir = path.join(workspace, ".buildchain/downloaded-manifests/linux");
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, "manifest.json"),
      JSON.stringify({
        artifactName: "libnode-linux-x64",
        platform: { id: "linux-x64", name: "Linux x64" },
        summary: { fileCount: 1, totalBytes: 32 },
        expectedArtifacts: { ok: true },
      }, null, 2),
    );
    fs.mkdirSync(path.join(workspace, ".buildchain/artifacts"), { recursive: true });
    const buildSummary = {
      contract: "kungfu-buildchain-build-summary",
      artifactName: "libnode",
      git: {
        repository: "kungfu-systems/libnode",
        sha: "a".repeat(40),
        ref: "refs/pull/42/merge",
        treeSha: "b".repeat(40),
      },
      publishGate: { channel: "alpha" },
      publishSource: {
        ref: "publish-gate/alpha/v22/v22.22/22.22.3-kf.0",
        sha: "a".repeat(40),
        channel: "alpha",
        line: "v22/v22.22",
        consumerVersion: "22.22.3-kf.0",
      },
      platforms: [{
        artifactName: "libnode-linux-x64",
        platform: { id: "linux-x64", name: "Linux x64" },
        summary: { fileCount: 1, totalBytes: 32 },
        manifestPath: ".buildchain/downloaded-manifests/linux/manifest.json",
      }],
      fileCount: 1,
      totalBytes: 32,
    };
    fs.writeFileSync(
      path.join(workspace, ".buildchain/artifacts/build-summary.json"),
      JSON.stringify(buildSummary, null, 2),
    );
    const passport = createReleaseCandidatePassport({
      repository: "kungfu-systems/libnode",
      pullRequest: {
        number: 42,
        url: "https://github.com/kungfu-systems/libnode/pull/42",
        headRef: "dev/v22/v22.22",
        baseRef: "alpha/v22/v22.22",
      },
      targetChannel: "alpha/v22/v22.22",
      version: "22.22.3-kf.0",
      sourceHeadSha: "a".repeat(40),
      mergeRefSha: "a".repeat(40),
      sourceTreeHash: "b".repeat(40),
      buildSummary,
    });
    const passportPath = path.join(workspace, ".buildchain/artifacts/release-candidate-passport.json");
    fs.writeFileSync(passportPath, `${JSON.stringify(passport, null, 2)}\n`);
    assert.equal(passport.contract, RELEASE_CANDIDATE_PASSPORT_CONTRACT);
    assert.ok(fs.existsSync(passportPath));
    const validation = validatePromotionReleaseCandidate({
      cwd: workspace,
      passportPath,
      buildSummaryPath: ".buildchain/artifacts/build-summary.json",
      repository: "kungfu-systems/libnode",
      targetChannel: "alpha",
      version: "22.22.3-kf.0",
      sourceHeadSha: "c".repeat(40),
      sourceTreeSha: "b".repeat(40),
    });
    assert.equal(validation.builtSourceSha, "a".repeat(40));
    assert.equal(validation.builtSourceTreeSha, "b".repeat(40));
    assert.equal(validation.promotionChannelSha, "c".repeat(40));
    assert.equal(validation.promotionChannelTreeSha, "b".repeat(40));
    assert.equal(validation.treeEquivalent, true);
    assert.throws(
      () =>
        validatePromotionReleaseCandidate({
          cwd: workspace,
          passportPath,
          buildSummaryPath: ".buildchain/artifacts/build-summary.json",
          repository: "kungfu-systems/libnode",
          targetChannel: "alpha",
          version: "22.22.3-kf.0",
          sourceHeadSha: "c".repeat(40),
          sourceTreeSha: "d".repeat(40),
        }),
      /source identity mismatch/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("release-candidate resolver requires one merged PR-stage RC artifact", async () => {
  const targetSha = "c".repeat(40);
  const builtSourceSha = "a".repeat(40);
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const jsonResponse = (value) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
    });
    if (url.endsWith(`/commits/${targetSha}/pulls`)) {
      return jsonResponse([
        {
          number: 42,
          html_url: "https://github.com/kungfu-systems/libnode/pull/42",
          merged_at: "2026-07-04T00:00:00Z",
          updated_at: "2026-07-04T00:00:00Z",
          base: { ref: "alpha/v22/v22.22" },
          head: {
            sha: builtSourceSha,
            ref: "dev/v22/v22.22",
            repo: { full_name: "kungfu-systems/libnode" },
          },
        },
      ]);
    }
    if (url.includes("actions/workflows/build-surface-fixture.yml/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 456,
            name: "Build Surface Fixture",
            event: "pull_request",
            status: "completed",
            conclusion: "success",
            head_sha: builtSourceSha,
            head_branch: "dev/v22/v22.22",
            updated_at: "2026-07-04T00:01:00Z",
            pull_requests: [{ number: 42 }],
            head_repository: { full_name: "kungfu-systems/libnode" },
          },
        ],
      });
    }
    if (url.includes("actions/runs/456/artifacts")) {
      return jsonResponse({
        artifacts: [
          {
            id: 123,
            name: `libnode-release-candidate-${builtSourceSha}`,
            expired: false,
          },
          {
            id: 124,
            name: `libnode-summary-${builtSourceSha}`,
            expired: false,
          },
        ],
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await resolveReleaseCandidateArtifacts({
    repository: "kungfu-systems/libnode",
    targetSha,
    targetRef: "alpha/v22/v22.22",
    workflowFile: "build-surface-fixture.yml",
    workflowName: "Build Surface Fixture",
    fetchImpl,
    download: false,
  });
  assert.equal(result.artifacts.passport, `libnode-release-candidate-${builtSourceSha}`);
  assert.equal(result.artifacts.summary, `libnode-summary-${builtSourceSha}`);
  assert.equal(result.run.id, "456");
  assert.equal(result.pullRequest.number, 42);
  assert.equal(seen.length, 3);
});

test("run-lifecycle action accepts hyphenated GitHub Action inputs", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-action-"),
  );
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixture");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  try {
    runLifecycle({
      cwd: fixture,
      stageName: "install",
      required: true,
      workspace,
    });
    runLifecycle({
      cwd: fixture,
      stageName: "build",
      required: true,
      workspace,
    });
    const processSummaryPath = path.join(workspace, ".buildchain/diagnostics/action-process-summary.json");
    fs.mkdirSync(path.dirname(processSummaryPath), { recursive: true });
    fs.writeFileSync(processSummaryPath, `${JSON.stringify({
      schemaVersion: 1,
      contract: BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
      requestedParallelism: 4,
      requestedParallelismSource: "explicit",
      observedConcurrency: { max: 2, ratioToRequestedMax: 0.5 },
      sampleCount: 1,
      categories: { compiler: 1 },
      topCommands: [{ command: "clang++", count: 1 }],
    })}\n`);
    const manifestPath = path.join(
      workspace,
      ".buildchain/artifacts/linux-x64/manifest-action.json",
    );
    const outputPath = path.join(workspace, "github-output.txt");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "actions/run-lifecycle/dist/index.js")],
      {
        cwd: workspace,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          INPUT_CWD: fixture,
          INPUT_STAGE: "verify",
          INPUT_REQUIRED: "true",
          "INPUT_ARTIFACT-NAME": "libnode-shaped-linux-x64-test",
          "INPUT_MANIFEST-ARTIFACT-NAME": "libnode-manifest-linux-x64-test",
          "INPUT_DIAGNOSTICS-ARTIFACT-NAME": "libnode-diagnostics-linux-x64-test",
          "INPUT_PLATFORM-ID": "linux-x64",
          "INPUT_PLATFORM-NAME": "Linux x64",
          "INPUT_ARTIFACT-PATHS": "fixture/dist",
          "INPUT_MANIFEST-PATH":
            ".buildchain/artifacts/linux-x64/manifest-action.json",
          "INPUT_SUMMARY-PATH":
            ".buildchain/artifacts/linux-x64/summary-action.json",
          "INPUT_EXPECTED-ARTIFACTS-JSON":
            '{"minFiles":2,"requiredPaths":["fixture/dist/install.txt","fixture/dist/libnode-shaped.txt"]}',
          "INPUT_PROCESS-SUMMARY-PATH": ".buildchain/diagnostics/action-process-summary.json",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const summary = JSON.parse(
      fs.readFileSync(
        path.join(
          workspace,
          ".buildchain/artifacts/linux-x64/summary-action.json",
        ),
        "utf8",
      ),
    );
    const outputs = fs.readFileSync(outputPath, "utf8");
    const diagnostics = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.artifactName, "libnode-shaped-linux-x64-test");
    assert.equal(manifest.platform.id, "linux-x64");
    assert.equal(summary.artifactName, "libnode-shaped-linux-x64-test");
    assert.match(outputs, /artifact-summary-json=/);
    assert.match(outputs, /expected-artifacts-ok=true/);
    assert.equal(diagnostics.process.requestedParallelism, 4);
    assert.equal(diagnostics.process.observedConcurrency.max, 2);
    assert.equal(diagnostics.links.artifactName, "libnode-shaped-linux-x64-test");
    assert.equal(diagnostics.links.manifestArtifactName, "libnode-manifest-linux-x64-test");
    assert.equal(diagnostics.links.diagnosticsArtifactName, "libnode-diagnostics-linux-x64-test");
    assert.equal(diagnostics.links.diagnosticsManifest, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json");
    assert.equal(diagnostics.links.processSummary, ".buildchain/diagnostics/action-process-summary.json");
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json")));
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["fixture/dist/install.txt", "fixture/dist/libnode-shaped.txt"],
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("run-lifecycle action samples a configured lifecycle stage from the bundled dist", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-action-sampled-"),
  );
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixture");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  try {
    runLifecycle({
      cwd: fixture,
      stageName: "install",
      required: true,
      workspace,
    });
    const outputPath = path.join(workspace, "github-output-sampled.txt");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "actions/run-lifecycle/dist/index.js")],
      {
        cwd: workspace,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          INPUT_CWD: fixture,
          INPUT_STAGE: "build",
          INPUT_REQUIRED: "true",
          "INPUT_ARTIFACT-NAME": "libnode-shaped-linux-x64-sampled-action",
          "INPUT_PLATFORM-ID": "linux-x64",
          "INPUT_PLATFORM-NAME": "Linux x64",
          "INPUT_ARTIFACT-PATHS": "fixture/dist",
          "INPUT_MANIFEST-PATH":
            ".buildchain/artifacts/linux-x64/manifest-sampled-action.json",
          "INPUT_DIAGNOSTICS-PATH":
            ".buildchain/artifacts/linux-x64/diagnostics-sampled-action.json",
          "INPUT_PROCESS-SUMMARY-PATH": ".buildchain/diagnostics/action-process-summary.json",
          "INPUT_PROCESS-SAMPLES-PATH": ".buildchain/diagnostics/action-process-samples.jsonl",
          "INPUT_SAMPLE-PROCESS-TREE": "true",
          "INPUT_PROCESS-SAMPLE-INTERVAL-MS": "1000",
          "INPUT_REQUESTED-PARALLELISM": "6",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const processSummary = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/diagnostics/action-process-summary.json"),
        "utf8",
      ),
    );
    const diagnostics = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics-sampled-action.json"),
        "utf8",
      ),
    );
    assert.equal(processSummary.contract, BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT);
    assert.equal(processSummary.summary.requestedParallelism, 6);
    assert.equal(diagnostics.process.requestedParallelism, 6);
    assert.ok(fs.existsSync(path.join(workspace, ".buildchain/diagnostics/action-process-samples.jsonl")));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
