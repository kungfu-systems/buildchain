import { compactProductionReleasePrSummary } from "../packages/core/web/release-pr-summary.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectWorkflowJob, readWorkflow } from "../scripts/workflow-action-graph.mjs";
import { DEFAULT_ARTIFACT_NAME_TEMPLATE, resolveArtifactContract } from "../packages/core/build/artifact/naming.js";
import { LINUX_CONTAINER_PRESETS } from "../packages/core/build/runner/presets.js";
import { createResolvedReleaseManifest } from "../packages/core/release/source/manifest.js";
import { parsePublishSourceRef, resolvePublishChannelTargetRef, resolvePublishSourceLock, verifyPublishSourceLock } from "../packages/core/release/source/coordinates.js";
import { parseExpectedArtifactsJson } from "../packages/core/build/artifact/expectations.js";
import { verifyPublishChannelPrLineage, verifyPublishChannelRef } from "../packages/core/release/source/lineage.js";
import { planPackageSetPublish } from "../packages/core/publication/npm/package-plan.js";
import { resolvePublishGate } from "../packages/core/release/promotion/publish-gate.js";
import { resolveRunnerMatrix } from "../packages/core/build/runner/matrix.js";
import { aggregateBuildSummaryCli } from "../packages/core/build/commands/aggregate-build-summary.mjs";
import { aggregateDiagnosticsSummaryCli } from "../packages/core/observability/commands/aggregate-diagnostics-summary.mjs";
import {
  cleanupRelayArtifacts,
  downloadRelayArtifacts,
  uploadRelayArtifacts,
} from "../packages/core/providers/artifact-relay/transactions.js";
import {
  RELEASE_REVIEW_MARKER,
  renderReleaseReviewComment,
  resolveReleaseReviewState,
} from "../packages/core/web/release-review.js";
import { createProductionReleasePrHandoff, releaseBranchName, renderProductionReleasePrBody } from "../packages/core/web/release-pr-handoff.js";
import { openProductionReleasePr } from "../packages/core/web/release-pr-provider.js";
import { recordProductionReleasePrOutcome } from "../packages/core/web/release-pr-transaction.js";
import { readStagingReleasePrSummary, webSurfaceProductionReleasePrCli } from "../packages/core/web/commands/web-surface-production-release-pr.mjs";
import { compactWebSurfaceApplyResult } from "../packages/core/web/deployment/apply-evidence.js";

import {
  RELEASE_FEEDBACK_MARKERS,
  createWebSurfaceReleasePassport,
  normalizeActorIdentity,
  renderWebSurfaceReleaseFeedbackComment,
} from "../packages/core/web/release-feedback.js";
import {
  currentGitHubRefSha,
  resolvePublishSourceRefSha,
} from "../packages/core/release/commands/publish-source-ref-resolver.mjs";
import {
  RELEASE_CANDIDATE_PASSPORT_CONTRACT,
  createReleaseCandidatePassport,
} from "../packages/core/release/release-candidate.js";
import { validatePromotionReleaseCandidate } from "../packages/core/release/promote-ref/internal/candidate-admission.js";
import { resolveReleaseCandidateArtifacts } from "../packages/core/release/candidate/resolve.js";
import {
  classifyBuildchainRuntimeRef,
  normalizeRequestedRuntimeRef,
  resolveRuntimeSelection,
  validateRuntimeOverrideTrust,
} from "../packages/core/runtime/commands/runtime-ref-core.mjs";
import { resolvePublishSourceCli } from "../packages/core/release/commands/resolve-publish-source.mjs";
import { evaluateBuildchainContractLock } from "../packages/core/contracts/buildchain-contract.js";
import {
  canAdmitSelfDogfoodLockEvaluation,
  contractForSelfDogfoodEvaluation,
  hasQualifiedSelfDogfoodBootstrapAuthority,
  resolveSelfDogfoodMajor,
} from "../packages/core/release/self-dogfood-version.js";
import { runLifecycle } from "../packages/core/build/lifecycle/transaction.js";
import { verifyBuildLifecycleCompilerCacheActivity } from "../packages/core/build/lifecycle/artifacts.js";
import { verifyPublishChannelRefCli } from "../packages/core/release/commands/verify-publish-channel-ref.mjs";
import { verifyPublishSourceLockCli } from "../packages/core/release/commands/verify-publish-source-lock.mjs";
import {
  discoverConfiguredVersionStateFiles,
  loadBuildchainConfig,
  updateConfiguredVersionStateContents,
  validateBuildchainConfig,
} from "../packages/core/consumer/buildchain-config.js";
import {
  BUILDCHAIN_DIAGNOSTICS_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
} from "../packages/core/observability/diagnostics.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("promote action exposes generic publish source-lock gate", () => {
  const action = fs.readFileSync(
    path.join(root, "actions/release/promotion/ref/action.yml"),
    "utf8",
  );
  const graph = inspectWorkflowJob(".github/workflows/public-release-paper.yml", "publish");
  const implementation = ["action-inputs.js", "action-outputs.js", "source-lock.js"].map(file => {
    const source = graph.modules.get(`packages/core/release/promote-ref/${file}`);
    assert.ok(source, file);
    return source;
  }).join("\n");

  assert.match(action, /require-publish-source-lock:/);
  assert.match(action, /publish-source-ref:/);
  assert.match(action, /publish-source-sha:/);
  assert.match(action, /publish-source-locked:/);
  assert.match(action, /expected-publication-version:/);
  assert.match(action, /planned-publication-version:/);
  assert.match(action, /planned-release-candidate-version:/);
  assert.match(implementation, /expectedPublicationVersion/);
  assert.match(implementation, /planned-publication-version/);
  assert.match(implementation, /planned-release-candidate-version/);
  assert.match(implementation, /kungfu-buildchain-publish-source-lock-validation/);
  assert.match(implementation, /publish-gate\/\{alpha,release,major\}/);
  assert.match(implementation, /does not match promotion sha/);
});

test("promote action path-backed artifact input imports its runtime dependencies", () => {
  const implementation = fs.readFileSync(
    path.join(root, "packages/core/release/promote-ref/action-inputs.js"),
    "utf8",
  );

  assert.match(implementation, /import fs from "node:fs";/);
  assert.match(implementation, /import path from "node:path";/);
  assert.match(
    implementation,
    /fs\.readFileSync\(path\.resolve\(publishRequiredArtifactsPath\), "utf8"\)/,
  );
});

test("canonical publisher keeps governance declarations outside provider execution", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "contracts/promotion-request-v1.schema.json")));
  assert.ok(schema.properties["branch-protection-bypass-apps"]);
  for (const field of ["branch-protection-bypass-users", "branch-protection-bypass-teams", "publish-command"]) {
    assert.equal(schema.properties[field], undefined);
  }
  const apply = inspectWorkflowJob(".github/workflows/.release-promote.yml", "apply");
  assert.ok(apply.actions.has("actions/release/promotion/candidate"));
  assert.ok(![...apply.modules.keys()].some(file => file.includes("/promote-ref/")));
});
test("qualification verifies the invocation before checkout and admits the contract before candidate resolution", () => {
  const graph = inspectWorkflowJob(".github/workflows/.release-promote.yml", "qualify");
  const names = ["Validate the complete invocation before runtime checkout", "Checkout the selected runtime for read-only qualification", "Prepare locked runtime dependencies", "Qualify the sealed candidate and exact publication intent"];
  const positions = names.map(name => graph.steps.findIndex(step => step.name === name));
  assert.ok(positions.every((position, index) => position >= 0 && (!index || positions[index - 1] < position)), JSON.stringify({ names, positions }));
});
test("self promotion enters the public API at the same source commit", () => {
  const workflow = readWorkflow(".github/workflows/self-release-promote.yml");
  assert.equal(workflow.jobs.promote.uses, "./.github/workflows/public-release-promote.yml");
  assert.equal(workflow.jobs["promote-stable"], undefined);
  assert.deepEqual(Object.keys(workflow.jobs.promote.with), ["request-json"]);
});
test("SETTLE consumes APPLY evidence and emits the sole terminal receipt projection", () => {
  const graph = inspectWorkflowJob(".github/workflows/.release-promote.yml", "settle");
  assert.deepEqual(graph.job.needs, ["qualify", "apply"]);
  assert.equal(graph.job.permissions.contents, "read");
  assert.notEqual(graph.job.permissions["id-token"], "write");
  const restore = graph.steps.findIndex(step => step.name === "Restore canonical APPLY evidence");
  const verify = graph.steps.findIndex(step => step.name === "Verify the single terminal receipt");
  assert.ok(restore >= 0 && restore < verify);
  assert.match(graph.steps[restore].with.name, /release-apply/);
  const node = graph.actions.get("actions/release/promotion/settle");
  assert.equal(node.outputs["controller-receipt-digest"].value, "${{ steps.verify.outputs.receipt-root }}");
  assert.match(graph.steps.find(step => step.name === "Retain SETTLE projection").with.path, /release-receipt\.json/);
  assert.match(graph.modules.get("packages/core/publication/settlement/actions.js"), /verifyPublicationSettlement\(/);
});
test("reusable build seals release-candidate passport in its final result", () => {
  const final = fs.readFileSync(path.join(root, "packages/core/build/summary/finalization.js"), "utf8");
  assert.match(final, /build.artifacts.release_candidate/u);
  assert.match(final, /writeReleaseCandidatePassport\(\{/u);
  assert.match(final, /sourceTreeHash: plan.source.tree_sha/u);
  assert.match(final, /gateAggregate: plan.evidence.gate_profile_json/u);
  assert.match(final, /familyEvidence: plan.evidence.candidate_family_json/u);
  assert.match(final, /artifacts.release_candidate = await upload/u);
});

test("environment preparation exposes runner-local tools before lifecycle execution", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  const prepare = fs.readFileSync(path.join(root, "packages/core/build/environment/provision.js"), "utf8");
  assert.match(prepare, /path.join\(home, ".local\/bin"\)/u);
  assert.match(prepare, /path.join\(home, ".cargo\/bin"\)/u);
  assert.match(fs.readFileSync(path.join(root, "packages/core/build/environment/action.js"), "utf8"), /for \(const directory of result.paths\) core.addPath\(directory\)/u);
  for (const jobId of ["build-native", "build-container"]) {
    const steps = readWorkflow(".github/workflows/.build.yml").jobs[jobId].steps;
    const prepared = steps.findIndex(step => step.uses?.endsWith("/actions/build/lifecycle/prepare"));
    const stages = steps.flatMap((step, index) => step.uses?.endsWith("/actions/build/lifecycle/stage") ? [index] : []);
    assert.equal(stages.length, 3);
    assert.ok(prepared >= 0 && stages.every(index => index > prepared));
  }
});

test("reusable Shifu Gate workflow keeps project policy outside Buildchain", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.build-gate-profile.yml"), "utf8");
  const nodes = ["plan", "run-gates", "aggregate"].map(stage =>
    fs.readFileSync(path.join(root, `actions/build/gate/${stage === "run-gates" ? "execute" : stage}/action.yml`), "utf8")).join("\n");
  for (const input of ["gate-command-json", "gate-plan-command-json", "gate-environment-json", "shifu-cache-profile-ref",
    "platforms-json", "checkout-cache-mode", "checkout-cache-fallback", "checkout-cache-fetch-attempts",
    "rust-toolchain", "rustup-dist-server", "rustup-update-root", "cargo-registry-index"]) assert.ok(workflow.includes(`${input}:`));
  for (const operation of ["resolve", "run-profile", "qualify-profile"]) assert.ok(nodes.includes(`/actions/build/gate/${operation}`));
  assert.match(nodes, /request-json: \$\{\{ inputs.request-json \}\}/);
  assert.match(nodes, /dtolnay\/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30/);
  assert.match(nodes, /actions\/runtime\/toolchain\/windows-rust/);
  assert.equal((nodes.match(/diagnostics-path: .buildchain\/diagnostics\/(?:source|runtime)-checkout.json/g) || []).length, 2);
  assert.doesNotMatch(nodes, /runtime-bootstrap\/locked-source-checkout|Download Buildchain runtime checkout bootstrap/);
  assert.doesNotMatch(workflow + nodes, /product\.verify|gate\.catalog|dev-patrol|alpha-pr|release-pr/);
});

test("build fixture keeps project settings in TOML and seals exact candidate bytes", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/self-build-fixture.yml"), "utf8");
  const config = fs.readFileSync(path.join(root, "fixtures/libnode-shaped/buildchain.toml"), "utf8");
  assert.match(workflow, /config-path: fixtures\/libnode-shaped\/buildchain.toml/u);
  assert.doesNotMatch(workflow, /artifact-transfer-mode:|buildchain-ref:|publish-source-ref:|publish-anchor-request-json:/u);
  assert.match(config, /environment = "github-hosted-container"/u);
  assert.match(config, /release_candidate = true/u);
  assert.match(workflow, /uses: kungfu-systems\/buildchain\/.github\/workflows\/build.yml@v4-alpha/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  const graph = inspectWorkflowJob(".github/workflows/self-build-fixture.yml", "buildchain-package-candidate");
  assert.match(graph.job.steps.find(step => step.id === "node").with["passport-artifact"], /needs\.libnode-shaped\.outputs\.release-candidate-artifact/u);
  const download = graph.steps.findIndex(step => step.name === "Download exact Release Candidate Passport");
  const pack = graph.steps.findIndex(step => step.id === "package");
  assert.ok(download >= 0 && download < pack);
  const source = graph.modules.get("packages/core/publication/candidate/package-binding.js");
  assert.match(graph.modules.get("packages/core/publication/candidate/package.js"), /\["show", "-s", "--format=%T", "HEAD"\]/u);
  assert.match(source, /tree === passport.source.treeHash/u);
});
test("canonical publisher carries no issue-reporting mutation authority", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.release-promote.yml"),
    "utf8",
  );
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /workflow-friction-report\.mjs/);
});
test("promote action exposes promote-only release candidate inputs", () => {
  const action = fs.readFileSync(
    path.join(root, "actions/release/promotion/ref/action.yml"),
    "utf8",
  );
  const implementation = fs.readFileSync(
    path.join(root, "packages/core/release/promote-ref/action-inputs.js"),
    "utf8",
  );
  const docs = fs.readFileSync(
    path.join(root, "actions/release/promotion/ref/README.md"),
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
  assert.match(action, /release-passport-kfd-adopter-manifest-json:/);
  assert.match(action, /release-passport-kfd-support-matrix-json:/);
  assert.match(action, /release-passport-kfd-product-gate-jsons:/);
  assert.match(action, /release-passport-invariant-passport-jsons:/);
  assert.match(action, /release-passport-invariant-passport-command:/);
  assert.match(action, /release-passport-evidence-jsons:/);
  assert.match(action, /release-passport-attachment-command:/);
  assert.doesNotMatch(action + implementation, /release-passport-evidence-command/);
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
  assert.match(implementation, /releasePassportKfdAdopterManifestJson/);
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
  assert.match(docs, /release-passport-kfd-adopter-manifest-json/);
  assert.match(docs, /release-passport-kfd-support-matrix-json/);
  assert.match(docs, /release-passport-kfd-product-gate-jsons/);
  assert.match(docs, /release-passport-invariant-passport-command/);
  assert.match(docs, /release-passport-evidence-jsons/);
  assert.match(docs, /release-passport-attachment-command/);
  assert.match(docs, /publish-rematerialize-on-resume: true/);
});

test("buildchain ref promotion delegates alpha evidence to the canonical publisher", () => {
  const workflow = readWorkflow(".github/workflows/self-release-promote.yml");
  assert.equal(workflow.jobs.promote.uses, "./.github/workflows/public-release-promote.yml");
  const request = workflow.jobs.promote.with["request-json"];
  assert.match(request, /"release-candidate-workflow-file": "self-build-fixture\.yml"/);
  assert.match(request, /"resume-candidate-run-id":/);
  assert.doesNotMatch(request, /declarative-release-tail/);
  assert.match(request, /"release-passport-impact-json": "\.buildchain\/release-impact\.json"/);
});
test("QUALIFY receives the rooted transient runtime authorization and publication channel", () => {
  const graph = inspectWorkflowJob(".github/workflows/.release-promote.yml", "qualify");
  const candidate = graph.steps.find(step => step.uses?.endsWith("/release/promotion/qualify-candidate"));
  assert.equal(candidate.with["request-json"], "${{ inputs.request-json }}");
  const implementation = graph.modules.get("packages/core/release/promotion/candidate.js");
  assert.match(implementation, /authorizationJson: request\["promotion-runtime-authorization-json"\]/u);
  assert.match(implementation, /authorizationRoot: request\["promotion-runtime-authorization-root"\]/u);
  assert.match(implementation, /channel: request\["promotion-publication-channel"\] \|\| intent.channel/u);
});
test("promote-buildchain-ref owns semver GitHub Release publication", () => {
  const action = fs.readFileSync(
    path.join(root, "actions/release/promotion/ref/action.yml"),
    "utf8",
  );
  const source = fs.readFileSync(
    path.join(root, "packages/core/release/promote-ref/release-tail.js"),
    "utf8",
  );
  const githubReleaseSource = fs.readFileSync(
    path.join(root, "packages/core/release/github-release.js"),
    "utf8",
  );
  const implementation = `${source}\n${githubReleaseSource}`;

  assert.match(action, /github-release:/);
  assert.match(action, /github-release-artifact-paths:/);
  assert.doesNotMatch(action, /github-release-title:/);
  assert.doesNotMatch(action, /github-release-notes:/);
  assert.match(action, /public-release-tag:/);
  assert.match(action, /github-release-url:/);
  assert.match(action, /github-release-action:/);
  assert.match(implementation, /ensureGitHubRelease/);
  assert.match(implementation, /publishGitHubReleaseEvidence/);
  assert.match(implementation, /collectGitHubReleaseEvidenceAssets/);
  assert.match(implementation, /duplicate asset basename/);
  assert.match(fs.readFileSync(path.join(root, "packages/core/release/release-tail-provider-adapters.js"), "utf8"), /uploadReleaseAsset/);
  assert.match(source, /publishTransaction\?\.state === "complete"/);
  assert.match(source, /transaction-state=/);
  assert.match(source, /finalizationNeeded !== true/);
});

test("stable recovery keeps candidate bytes immutable while preparing the next alpha", () => {
  const versionState = fs.readFileSync(
    path.join(root, "packages/core/release/promote-ref/internal/version-state-operations.js"),
    "utf8",
  );
  const releaseChannel = fs.readFileSync(
    path.join(root, "packages/core/release/promote-ref/internal/promote-release-channel.js"),
    "utf8",
  );
  assert.match(
    versionState,
    /recoveredCandidate = releaseCandidateValidation\?\.recoveredCandidate === true/u,
  );
  assert.match(
    releaseChannel,
    /message: `chore\(release\): prepare \$\{selectedNextAlpha\.tag\}`,[\s\S]*?recoveredCandidate: false/u,
  );
});

test("build docs keep ordinary source identity separate from release promotion", () => {
  const docs = fs.readFileSync(path.join(root, "docs/reusable-build-surface.md"), "utf8");
  assert.match(docs, /source SHA, called-workflow SHA/);
  assert.match(docs, /specialized release\/recovery entry points/);
  assert.match(docs, /Release promotion consumes an already sealed candidate/);
});

test("promote action docs describe publish source-lock inputs", () => {
  const docs = fs.readFileSync(
    path.join(root, "actions/release/promotion/ref/README.md"),
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
    },
  );
  assert.equal(
    parsePublishSourceRef("publish-gate/release/v22/v22.22/22.22.3-kf.0")
      .channel,
    "release",
  );
  assert.equal(parsePublishSourceRef("publish-gate/anchor").anchor, true);
  assert.equal(parsePublishSourceRef("publish-gate/major").channel, "major");
  assert.throws(() => parsePublishSourceRef("major-gate"), /unsupported publish source ref/);
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

test("Buildchain independently dogfoods zero-input alpha and one-input stable TOML builds", () => {
  for (const channel of ["alpha", "stable"]) {
    const workflow = fs.readFileSync(path.join(root, `.github/workflows/self-build-${channel}-dogfood.yml`), "utf8");
    assert.match(workflow, /workflows: \["Buildchain Ref Promotion"\]/u);
    assert.ok(workflow.includes(`build.yml@${channel === "alpha" ? "v4-alpha" : "v4"}`));
    assert.doesNotMatch(workflow, /steps:|buildchain-channel:|working-directory:|runner-preset:/u);
    if (channel === "alpha") assert.doesNotMatch(workflow, /with:|config-path:/u);
    else assert.match(workflow, /config-path: fixtures\/libnode-shaped\/buildchain.toml/u);
  }
});
test("self-dogfood never bridges an adjacent major or bypasses contract compatibility", () => {
  assert.deepEqual(
    resolveSelfDogfoodMajor({
      packageVersion: "2.14.18-alpha.5",
      alphaRef: "v2-alpha",
    }),
    { packageMajor: 2, workflowMajor: 2, bootstrap: false },
  );
  for (const input of [
    { packageVersion: "3.0.0", alphaRef: "v2-alpha" },
    { packageVersion: "3.0.0-alpha.0", alphaRef: "v2-alpha", majorBootstrap: true },
    { packageVersion: "3.0.1-alpha.0", alphaRef: "v2-alpha", majorBootstrap: true },
    { packageVersion: "4.0.0", alphaRef: "v3-alpha", majorBootstrap: true },
  ]) {
    assert.throws(
      () => resolveSelfDogfoodMajor(input),
      /must target the current major alpha ref/,
    );
  }
  const currentContract = { majorLine: "v4" };
  assert.equal(
    contractForSelfDogfoodEvaluation({
      currentContract,
      majorResolution: { packageMajor: 4, workflowMajor: 4, bootstrap: false },
    }),
    currentContract,
  );
  assert.equal(
    canAdmitSelfDogfoodLockEvaluation({
      evaluation: { compatible: false },
      majorResolution: { packageMajor: 4, workflowMajor: 3, bootstrap: true },
    }),
    false,
  );
  assert.equal(
    canAdmitSelfDogfoodLockEvaluation({
      evaluation: { compatible: true },
      majorResolution: { packageMajor: 4, workflowMajor: 4, bootstrap: false },
    }),
    true,
  );
});

test("major self-dogfood bootstrap authority is exact and qualification-bound", () => {
  const authority = JSON.parse(
    fs.readFileSync(path.join(root, "architecture/bootstrap-authority.json"), "utf8"),
  );
  assert.equal(
    hasQualifiedSelfDogfoodBootstrapAuthority({
      packageVersion: "4.0.0-alpha.0",
      alphaRef: "v3-alpha",
      authority,
    }),
    true,
  );
  for (const drift of [
    { qualification: { ...authority.qualification, candidateSelfQualified: true } },
    { qualification: { ...authority.qualification, activeExceptions: 1 } },
    { releaseLine: { ...authority.releaseLine, bootstrapCommit: "f".repeat(40) } },
  ]) {
    assert.equal(
      hasQualifiedSelfDogfoodBootstrapAuthority({
        packageVersion: "4.0.0-alpha.0",
        alphaRef: "v3-alpha",
        authority: { ...authority, ...drift },
      }),
      false,
    );
  }
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
    .replace('[lifecycle.verify]\ncommand = "node scripts/verify.mjs"', '[lifecycle.verify]\ncommand = "node scripts/verify.mjs"\nshell = "bash"\n\n[lifecycle.verify.env]\nBUILDCHAIN_STAGE_ENV = "stage-value"')
    .replace("[lifecycle.install]", '[lifecycle.env]\nBUILDCHAIN_SHARED_ENV = "shared-value"\n\n[lifecycle.install]'));
  try {
    runLifecycle({
      cwd: fixture,
      stageName: "verify",
      command: 'printf "%s\\n%s\\n%s\\n" "$0" "$BUILDCHAIN_SHARED_ENV" "$BUILDCHAIN_STAGE_ENV" > command-override.txt',
      required: true,
      workspace,
    });
    const output = fs.readFileSync(path.join(fixture, "command-override.txt"), "utf8").trim().split(/\r?\n/u);
    output[0] = output[0].split(/[\\/]/u).at(-1);
    assert.deepEqual(output, ["bash", "shared-value", "stage-value"]);
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

test("TOML timeout bounds both build jobs and the lifecycle implementation", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  const stage = fs.readFileSync(path.join(root, "packages/core/build/plan/lifecycle.js"), "utf8");
  assert.equal((workflow.match(/timeout-minutes: .*build\.timeout_minutes/g) || []).length, 2);
  assert.match(stage, /timeoutMinutes: plan.build.timeout_minutes/u);
});

test("aggregate diagnostics read only diagnostics documents from final artifacts", () => {
  const payloads = fs.readFileSync(path.join(root, "packages/core/build/summary/payloads.js"), "utf8");
  assert.match(payloads, /downloaded-diagnostics\/\$\{platform.id\}\/diagnostics.json/u);
  assert.match(payloads, /readJson\(diagnostics\)/u);
  const final = fs.readFileSync(path.join(root, "packages/core/build/summary/finalization.js"), "utf8");
  assert.match(final, /\["diagnostics-summary.json"\]/u);
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
          "node",
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
          merge_commit_sha: targetSha,
          base: { ref: "alpha/v22/v22.22" },
          head: {
            sha: builtSourceSha,
            ref: "dev/v22/v22.22",
            repo: { full_name: "kungfu-systems/libnode" },
          },
        },
      ]);
    }
    if (url.includes("actions/workflows/self-build-fixture.yml/runs")) {
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
    workflowFile: "self-build-fixture.yml",
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
    fs.writeFileSync(outputPath, "");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "actions/build/lifecycle/run/dist/index.js")],
      {
        cwd: workspace,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          GITHUB_WORKSPACE: workspace,
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
    assert.match(outputs, /artifact-summary-json<<([^\r\n]+)\r?\n\{"contract":"kungfu-buildchain-artifact-summary"/);
    assert.match(outputs, /expected-artifacts-ok<<([^\r\n]+)\r?\ntrue\r?\n\1/);
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
    fs.writeFileSync(outputPath, "");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "actions/build/lifecycle/run/dist/index.js")],
      {
        cwd: workspace,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          GITHUB_WORKSPACE: workspace,
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

test("self promotion classifies finalization from rooted state instead of display titles", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/self-release-promote.yml"),
    "utf8",
  );
  assert.match(workflow, /^  classify-workflow-run:/m);
  const graph = inspectWorkflowJob(".github/workflows/self-release-promote.yml", "classify-workflow-run");
  assert.match([...graph.modules.values()].join("\n"), /selectFinalizedProductPublicationVersion/u);
  assert.match(workflow, /needs\.classify-workflow-run\.outputs\.action == 'promote'/u);
  assert.doesNotMatch(workflow, /workflow_run\.display_title/u);
});
