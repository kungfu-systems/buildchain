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
  RELEASE_REVIEW_MARKER,
  renderReleaseReviewComment,
  resolveReleaseReviewState,
} from "../scripts/web-surface-release-pr-review.mjs";
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
import { runLifecycle } from "../scripts/run-lifecycle-core.mjs";
import { verifyPublishChannelRefCli } from "../scripts/verify-publish-channel-ref.mjs";
import { verifyPublishSourceLockCli } from "../scripts/verify-publish-source-lock.mjs";
import { validateBuildchainConfig } from "../packages/core/buildchain-config.js";
import {
  BUILDCHAIN_DIAGNOSTICS_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
} from "../packages/core/diagnostics.js";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

test("reusable build workflow exposes the required surface contract", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.build.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /runner-preset:/);
  assert.match(workflow, /platforms-json:/);
  assert.match(workflow, /linux-container-preset:/);
  assert.match(workflow, /linux-container-image:/);
  assert.match(workflow, /resolve-contract:/);
  assert.match(
    workflow,
    /fromJSON\(needs\.resolve-contract\.outputs\.native-platforms-json\)/,
  );
  assert.match(
    workflow,
    /fromJSON\(needs\.resolve-contract\.outputs\.container-platforms-json\)/,
  );
  assert.match(workflow, /Setup Buildchain Node\.js with fnm/);
  assert.match(workflow, /container:/);
  assert.match(workflow, /require-trusted-event:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /default: ""/);
  assert.match(workflow, /Resolve Buildchain runtime/);
  assert.match(workflow, /runtime-sha/);
  assert.match(workflow, /buildchain-ref override is only allowed for trusted workflow_dispatch runs/);
  assert.match(workflow, /refs\/heads\/train\/vN\/vN\.M\/<capability>/);
  assert.match(workflow, /publish-channel:/);
  assert.match(workflow, /publish-refs-json:/);
  assert.match(workflow, /publish-source-ref:/);
  assert.match(workflow, /publish-anchor-request-json:/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(workflow, /resolve-publish-gate\.mjs/);
  assert.match(workflow, /resolve-publish-source\.mjs --mode lock/);
  assert.match(workflow, /Verify publish target channel ref and PR lineage/);
  assert.match(workflow, /verify-publish-channel-ref\.mjs/);
  assert.ok(
    workflow.indexOf("Resolve publish source lock") <
      workflow.indexOf("Verify publish target channel ref and PR lineage"),
  );
  assert.ok(
    workflow.indexOf("Verify publish target channel ref and PR lineage") <
      workflow.indexOf("resolve-source:"),
  );
  assert.ok(
    workflow.indexOf("Verify publish target channel ref and PR lineage") <
      workflow.indexOf("build-native:"),
  );
  assert.ok(
    workflow.indexOf("Verify publish target channel ref and PR lineage") <
      workflow.indexOf("build-linux-container:"),
  );
  assert.match(workflow, /resolve-publish-source\.mjs --mode manifest/);
  assert.equal(
    (workflow.match(/Install Buildchain runtime dependencies/g) || []).length,
    4,
  );
  assert.equal(
    (workflow.match(/pnpm@11\.7\.0 install --dir \.buildchain\/runtime --prod --frozen-lockfile --ignore-scripts/g) || []).length,
    4,
  );
  assert.match(workflow, /install-command:/);
  assert.match(workflow, /build-command:/);
  assert.match(workflow, /verify-command:/);
  assert.match(workflow, /artifact-name:/);
  assert.match(workflow, /artifact-name-template:/);
  assert.match(workflow, /expected-artifacts-json:/);
  assert.match(workflow, /process-summary-path:/);
  assert.match(workflow, /sample-process-tree:/);
  assert.match(workflow, /process-sample-interval-ms:/);
  assert.match(workflow, /requested-parallelism:/);
  assert.match(workflow, /process-summary-required:/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /summary\.json/);
  assert.match(workflow, /diagnostics\.json/);
  assert.match(workflow, /diagnostics-manifest\.json/);
  assert.match(workflow, /events\.jsonl/);
  assert.match(workflow, /process-summary\.json/);
  assert.match(workflow, /process-samples\.jsonl/);
  assert.match(workflow, /-diagnostics-\$\{\{ matrix\.platform\.id \}\}-/);
  assert.match(workflow, /build-summary-artifact:/);
  assert.match(workflow, /build-diagnostics-summary-artifact:/);
  assert.match(workflow, /release-candidate-artifact:/);
  assert.match(workflow, /diagnostics-summary-artifact-name:/);
  assert.match(workflow, /build-diagnostics-summary-json:/);
  assert.match(workflow, /diagnostics contract warning/);
  assert.match(workflow, /sidecar manifest warning totals/);
  assert.match(workflow, /downloaded-diagnostics/);
  assert.match(workflow, /BUILDCHAIN_RUNTIME_SHA/);
  assert.match(workflow, /BUILDCHAIN_RUNTIME_TRUST_DECISION/);
  assert.match(workflow, /aggregate-diagnostics-summary\.mjs/);
  assert.match(workflow, /generate-release-candidate-passport\.mjs/);
  assert.match(workflow, /diagnostics-summary\.json/);
  assert.match(workflow, /\$\{\{ inputs\.artifact-name \}\}-release-candidate-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/);
  assert.match(workflow, /generate-release-candidate-passport\.mjs/);
  assert.match(workflow, /-diagnostics-summary-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/);
  assert.match(workflow, /Upload aggregate diagnostics summary/);
  assert.equal(
    (workflow.match(/manifest-artifact-name: \$\{\{ inputs\.artifact-name \}\}-manifest-\$\{\{ matrix\.platform\.id \}\}-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/diagnostics-artifact-name: \$\{\{ inputs\.artifact-name \}\}-diagnostics-\$\{\{ matrix\.platform\.id \}\}-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/process-summary-path: \$\{\{ inputs\.process-summary-path \|\| \(inputs\.sample-process-tree && '\.buildchain\/diagnostics\/process-summary\.json'\) \|\| '' \}\}/g) || []).length,
    4,
  );
  assert.equal(
    (workflow.match(/sample-process-tree: \$\{\{ inputs\.sample-process-tree \}\}/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/process-summary-required: \$\{\{ inputs\.require-build \}\}/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/process-summary-required: \$\{\{ inputs\.process-summary-path != '' \|\| inputs\.require-build \}\}/g) || []).length,
    2,
  );
  assert.match(workflow, /publish-allowed:/);
  assert.match(workflow, /publish-reason:/);
  assert.match(workflow, /publish-source-sha:/);
  assert.match(workflow, /release-manifest-json:/);
  assert.equal(
    (workflow.match(/artifact-summary-json: \$\{\{ steps\.summary\.outputs\.artifact-summary-json \}\}/g) || []).length,
    1,
  );
  assert.match(
    workflow,
    /ref: \$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/,
  );
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
});

test("release-candidate promote workflow is promote-only and never schedules a heavy build", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /release-candidate-resolver\.mjs/);
  assert.match(workflow, /release-candidate-workflow-file:/);
  assert.match(workflow, /default: "build\.yml"/);
  assert.match(workflow, /release-candidate-workflow-name:/);
  assert.match(workflow, /default: "Build"/);
  assert.match(workflow, /required-status-check:/);
  assert.match(workflow, /publish-mode:/);
  assert.match(workflow, /publish-dist-tag:/);
  assert.match(workflow, /publish-package-set-order:/);
  assert.match(workflow, /publish-package-main:/);
  assert.match(workflow, /release-passport-product-name:/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_NAME: \$\{\{ inputs\.artifact-name \}\}/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_PATTERNS: \$\{\{ inputs\.artifact-patterns \}\}/);
  assert.match(workflow, /BUILDCHAIN_RC_WORKFLOW_FILE: \$\{\{ inputs\.release-candidate-workflow-file \}\}/);
  assert.match(workflow, /BUILDCHAIN_RC_WORKFLOW_NAME: \$\{\{ inputs\.release-candidate-workflow-name \}\}/);
  assert.match(workflow, /BUILDCHAIN_REQUIRED_ARTIFACT_COUNT: \$\{\{ inputs\.required-artifact-count \}\}/);
  assert.match(workflow, /promote-only-release-candidate: "true"/);
  assert.match(workflow, /release-candidate-passport-path:/);
  assert.match(workflow, /release-candidate-build-summary-path:/);
  assert.match(workflow, /required-status-check: \$\{\{ inputs\.required-status-check \}\}/);
  assert.match(workflow, /publish-required-artifacts-json: \$\{\{ inputs\.publish-required-artifacts-json \|\| steps\.rc\.outputs\.publish-required-artifacts-json \}\}/);
  assert.match(workflow, /publish-dist-tag: \$\{\{ inputs\.publish-dist-tag \}\}/);
  assert.match(workflow, /publish-package-set-order: \$\{\{ inputs\.publish-package-set-order \}\}/);
  assert.match(workflow, /release-passport-platform-manifest-paths: \$\{\{ inputs\.release-passport-platform-manifest-paths \|\| steps\.rc\.outputs\.release-candidate-platform-manifest-paths \}\}/);
  assert.match(workflow, /Ensure publish-gate ref locks promotion commit/);
  assert.doesNotMatch(workflow, /\.github\/workflows\/\.build\.yml/);
  assert.doesNotMatch(workflow, /build-native:/);
  assert.doesNotMatch(workflow, /build-linux-container:/);
  assert.doesNotMatch(workflow, /fromJSON\(needs\.resolve-contract\.outputs/);
});

test("reusable web-surface workflow exposes preview, cleanup, staging, and production gates", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.web-surface.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /Resolve Buildchain runtime/);
  assert.match(workflow, /runtime-sha/);
  assert.match(workflow, /Validate web-surface apply inputs/);
  assert.match(workflow, /Validate apply inputs before build/);
  assert.ok(
    workflow.indexOf("Validate web-surface apply inputs") <
      workflow.indexOf("Run caller build"),
  );
  assert.match(workflow, /preview-aws-role-arn is required before preview-apply can build or deploy/);
  assert.match(workflow, /staging-aws-role-arn is required before staging-apply can build or deploy/);
  assert.match(workflow, /production-apply requires production-approved=true before production build or deploy/);
  assert.match(workflow, /production-aws-role-arn is required before production-apply can build or deploy/);
  assert.match(workflow, /production-release-on-main:/);
  assert.match(workflow, /production-release-label:/);
  assert.match(workflow, /production-release-head-prefix:/);
  assert.match(workflow, /Resolve production release PR intent/);
  assert.match(workflow, /listPullRequestsAssociatedWithCommit/);
  assert.match(workflow, /associated-release-pr-merged/);
  assert.match(workflow, /no-associated-release-pr/);
  assert.match(workflow, /Comment release PR staging review URL/);
  assert.match(workflow, /web-surface-release-pr-review\.mjs/);
  assert.match(workflow, /Plan pull request preview/);
  assert.match(workflow, /github\.event\.action != 'closed'/);
  assert.match(workflow, /Plan pull request preview cleanup/);
  assert.match(workflow, /pull-request-closed/);
  assert.match(workflow, /--dry-run false/);
  assert.match(workflow, /Apply pull request preview/);
  assert.match(workflow, /preview-aws-role-arn is required when preview-apply is true/);
  assert.match(workflow, /aws-actions\/configure-aws-credentials@v5/);
  assert.match(workflow, /buildchain:web-surface-preview/);
  assert.match(workflow, /web-surface-urls-json/);
  assert.match(workflow, /Preview deployed:/);
  assert.match(workflow, /preview-apply-result-json/);
  assert.match(workflow, /Apply pull request preview cleanup/);
  assert.match(workflow, /preview-cleanup-apply/);
  assert.match(workflow, /Plan main staging deploy/);
  assert.match(workflow, /github\.ref_name == 'main'/);
  assert.match(workflow, /needs\.release-intent\.outputs\.production-release-approved == 'true'/);
  assert.match(workflow, /Apply staging deploy/);
  assert.match(workflow, /staging-aws-role-arn is required when staging-apply is true/);
  assert.match(workflow, /Plan gated production deploy/);
  assert.match(workflow, /Apply production deploy/);
  assert.match(workflow, /inputs\.production-apply/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.production-approved/);
  assert.match(workflow, /github\.event_name == 'push' && github\.ref_name == 'main' && inputs\.production-release-on-main/);
  assert.match(workflow, /production-aws-role-arn is required when production-apply is true/);
  assert.match(
    workflow,
    /environment: \$\{\{ inputs\.production-environment \}\}/,
  );
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /actions\/download-artifact@v7\.0\.0/);
  assert.match(workflow, /--runtime-id "\$\{\{ needs\.runtime\.outputs\.runtime-sha \}\}"/);
  assert.match(workflow, /--rollback-pointer "\$\{\{ needs\.runtime\.outputs\.rollback-ref \}\}"/);
  assert.match(workflow, /release-feedback-actor-privacy:/);
  assert.match(workflow, /Comment staging deploy feedback and write passport/);
  assert.match(workflow, /buildchain-web-surface-staging-release-passport/);
  assert.match(workflow, /Comment production deploy feedback and write passport/);
  assert.match(workflow, /buildchain-web-surface-production-release-passport/);
  assert.match(workflow, /web-surface-release-feedback\.mjs/);
});

test("web-surface release PR review comments only on matching release PRs", () => {
  const payload = {
    pull_request: {
      number: 42,
      labels: [{ name: "buildchain-release" }],
      base: { ref: "main" },
      head: {
        ref: "feature/release-20260704",
        repo: { full_name: "kungfu-systems/site-kungfu-tech" },
      },
    },
  };
  const state = resolveReleaseReviewState(payload, {
    eventName: "pull_request",
    eventAction: "opened",
    repository: "kungfu-systems/site-kungfu-tech",
    productionReleaseOnMain: "true",
    productionReleaseLabel: "buildchain-release",
    productionReleaseHeadPrefix: "feature/release-",
  });
  assert.equal(state.shouldComment, true);
  assert.equal(state.pullNumber, 42);

  const missingLabel = resolveReleaseReviewState(
    { pull_request: { ...payload.pull_request, labels: [] } },
    {
      eventName: "pull_request",
      eventAction: "opened",
      repository: "kungfu-systems/site-kungfu-tech",
      productionReleaseOnMain: "true",
      productionReleaseLabel: "buildchain-release",
      productionReleaseHeadPrefix: "feature/release-",
    },
  );
  assert.equal(missingLabel.shouldComment, false);
  assert.equal(missingLabel.reason, "missing-release-label");
});

test("web-surface release PR review comment names staging and merge approval", () => {
  const body = renderReleaseReviewComment({
    stagingUrl: "https://staging.kungfu.tech",
    productionUrl: "https://kungfu.tech",
    label: "buildchain-release",
    headPrefix: "feature/release-",
  });
  assert.match(body, new RegExp(RELEASE_REVIEW_MARKER));
  assert.match(body, /Staging review URL: https:\/\/staging\.kungfu\.tech/);
  assert.match(body, /Production target: https:\/\/kungfu\.tech/);
  assert.match(body, /merge this release PR after staging has been verified/);
  assert.match(body, /same-repository release PR/);
});

test("web-surface release feedback passport records responsibility and renders status comment", () => {
  const passport = createWebSurfaceReleasePassport({
    channel: "production",
    repository: "kungfu-systems/site-kungfu-tech",
    sourceSha: "a".repeat(40),
    result: {
      status: "success",
      sourceSha: "a".repeat(40),
      urls: { default: "https://kungfu.tech" },
      artifactHash: "sha256:artifact",
      target: "site-production",
      manifest: { rollbackPointer: "refs/tags/v2" },
    },
    runId: "123",
    runUrl: "https://github.com/kungfu-systems/site-kungfu-tech/actions/runs/123",
    runtimeSha: "b".repeat(40),
    payload: { head_commit: { timestamp: "2026-07-04T00:00:00Z" } },
    sourceEvent: "push",
    target: { pullNumber: 42, sourceBranch: "feature/release-site", source: "release-intent" },
    gate: { label: "buildchain-release", headPrefix: "feature/release-" },
    privacyMode: "private-ref",
    actor: "keren",
    runnerActor: "GitHub Actions",
    oidcDeployIdentity: "arn:aws:iam::123456789012:role/site-production-github-actions",
  });

  assert.equal(passport.responsibility.pullRequest, 42);
  assert.equal(passport.responsibility.sourceEvent, "push");
  assert.equal(passport.responsibility.requiredGateEvidence.label, "buildchain-release");
  assert.match(passport.responsibility.humanDecisionActor, /^private-ref:sha256:/);
  assert.equal(
    normalizeActorIdentity("keren", { privacyMode: "redacted", kind: "human-decision-actor" }),
    "human-decision-actor:redacted",
  );

  const body = renderWebSurfaceReleaseFeedbackComment({
    channel: "production",
    passport,
    target: { pullNumber: 42 },
    passportArtifact: "buildchain-web-surface-production-release-passport",
  });
  assert.match(body, new RegExp(RELEASE_FEEDBACK_MARKERS.production));
  assert.match(body, /Status: `success`/);
  assert.match(body, /https:\/\/kungfu\.tech/);
  assert.match(body, /Rollback pointer: `refs\/tags\/v2`/);
  assert.match(body, /PR #42/);
});

test("binary distribution blocks invalid release uploads before the build matrix", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/binary-distribution.yml"),
    "utf8",
  );
  assert.match(workflow, /Binary distribution preflight/);
  assert.match(workflow, /Reject manual release upload before matrix/);
  assert.ok(
    workflow.indexOf("Binary distribution preflight") <
      workflow.indexOf("Build standalone binary archive"),
  );
  assert.match(workflow, /upload-release=true is only allowed on true tag-triggered release runs/);
  assert.match(workflow, /needs: preflight/);
  assert.match(workflow, /needs: \[preflight, binary\]/);
});

test("runtime train override accepts only trusted manual train or exact SHA refs", () => {
  assert.deepEqual(
    resolveRuntimeSelection({ requestedRef: "", workflowRef: "kungfu-systems/buildchain/.github/workflows/.build.yml@v2" }),
    {
      requestedRef: "",
      runtimeRef: "v2",
      runtimeFullRef: "v2",
      runtimeClass: "stable",
      runtimeOverride: false,
      workflowShellRef: "v2",
      rollbackRef: "v2",
      trustDecision: "stable-default",
    },
  );
  assert.equal(
    resolveRuntimeSelection({ requestedRef: "", workflowRef: "kungfu-systems/libnode/.github/workflows/build.yml@main" }).runtimeRef,
    "v2",
  );
  assert.equal(
    normalizeRequestedRuntimeRef("refs/heads/train/v2/v2.3/runtime-loader").ref,
    "train/v2/v2.3/runtime-loader",
  );
  assert.equal(classifyBuildchainRuntimeRef("train/v2/v2.3/runtime-loader"), "train");
  assert.equal(classifyBuildchainRuntimeRef("a".repeat(40)), "exact-sha");
  assert.throws(
    () => normalizeRequestedRuntimeRef("release/v2/v2.3"),
    /buildchain-ref override must be/,
  );
  assert.deepEqual(
    validateRuntimeOverrideTrust({
      requestedRef: "train/v2/v2.3/runtime-loader",
      eventName: "pull_request",
      actorPermission: "admin",
    }),
    {
      ok: false,
      decision: "rejected-untrusted-event",
      reason: "buildchain-ref override is only allowed for trusted workflow_dispatch runs",
    },
  );
  assert.equal(
    validateRuntimeOverrideTrust({
      requestedRef: "train/v2/v2.3/runtime-loader",
      eventName: "workflow_dispatch",
      actorPermission: "write",
    }).decision,
    "override-accepted",
  );
});

test("promote action exposes anchored publish source-lock gate", () => {
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
  assert.match(implementation, /validateAnchoredPackageRelease/);
  assert.match(implementation, /requirePublishGateSourceLock: true/);
  assert.match(implementation, /does not match promotion sha/);
});

test("reusable build exposes release-candidate passport outputs", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.build.yml"),
    "utf8",
  );

  assert.match(workflow, /release-candidate:/);
  assert.match(workflow, /publish-source-tree-sha:/);
  assert.match(workflow, /Resolve source tree SHA/);
  assert.match(workflow, /Generate release candidate passport/);
  assert.match(workflow, /BUILDCHAIN_RC_SOURCE_TREE_HASH/);
  assert.match(workflow, /release-candidate-passport-artifact/);
  assert.match(workflow, /release-candidate-passport-json/);
  assert.match(workflow, /<artifact-name>-release-candidate-|release-candidate-/);
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
    path.join(root, ".github/workflows/buildchain-ref-promotion.yml"),
    "utf8",
  );

  assert.match(action, /report-kind:/);
  assert.match(action, /workflow-friction/);
  assert.match(action, /comment-cooldown-hours:/);
  assert.match(action, /related-runs-json:/);
  assert.match(action, /heavy-builds-json:/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /Classify Buildchain promotion friction/);
  assert.match(workflow, /Report Buildchain promotion friction/);
  assert.match(workflow, /body-file: \$\{\{ steps\.friction\.outputs\.body-file \}\}/);
  assert.match(implementation, /Copyable issue body/);
  assert.match(implementation, /buildWorkflowFrictionIssueReport/);
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
  assert.match(action, /release-candidate-passport-path:/);
  assert.match(action, /release-candidate-build-summary-path:/);
  assert.match(implementation, /promoteOnlyReleaseCandidate/);
  assert.match(docs, /promote-only-release-candidate: "true"/);
});

test("buildchain ref promotion consumes PR-stage release candidate evidence", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-ref-promotion.yml"),
    "utf8",
  );

  assert.match(workflow, /Resolve release candidate evidence/);
  assert.match(workflow, /scripts\/release-candidate-resolver\.mjs/);
  assert.match(workflow, /promote-only-release-candidate: \$\{\{ steps\.release_candidate\.outputs\.promote-only-release-candidate \}\}/);
  assert.match(workflow, /release-candidate-passport-path: \$\{\{ steps\.release_candidate\.outputs\.release-candidate-passport-path \}\}/);
  assert.match(workflow, /release-candidate-build-summary-path: \$\{\{ steps\.release_candidate\.outputs\.release-candidate-build-summary-path \}\}/);
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

  const kungfu = resolveRunnerMatrix({ runnerPreset: "kungfu-v4-self-hosted" });
  assert.equal(kungfu.runnerPreset, "kungfu-v4-self-hosted");
  assert.equal(kungfu.nativePlatformCount, 3);
  assert.equal(kungfu.containerPlatformCount, 0);
  assert.deepEqual(
    kungfu.platforms.map((platform) => platform.id),
    ["linux-x64", "macos-arm64", "windows-x64"],
  );
  assert.match(kungfu.platforms[0].runner, /kungfu-build-v4-linux-x64/);

  const custom = resolveRunnerMatrix({
    platformsJson:
      '[{"id":"linux","name":"Linux","runner":"[\\"self-hosted\\",\\"Linux\\"]"}]',
  });
  assert.equal(custom.runnerPreset, "custom");
  assert.equal(custom.platformCount, 1);
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
    assert.equal(diagnostics.links.artifactName, "libnode-shaped-linux-x64-abc123");
    assert.equal(diagnostics.links.platformId, "linux-x64");
    assert.equal(diagnostics.links.processSummary, ".buildchain/diagnostics/process-summary.json");
    assert.equal(diagnostics.links.diagnosticsManifest, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json");
    assert.equal(diagnostics.links.diagnosticsEvents, ".buildchain/artifacts/linux-x64/events.jsonl");
    assert.equal(diagnostics.links.diagnosticsProcessSummary, ".buildchain/artifacts/linux-x64/process-summary.json");
    assert.equal(diagnostics.links.diagnosticsProcessSamples, ".buildchain/artifacts/linux-x64/process-samples.jsonl");
    const diagnosticsManifest = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json"),
        "utf8",
      ),
    );
    assert.equal(diagnosticsManifest.contract, BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT);
    assert.equal(diagnosticsManifest.artifactName, "libnode-shaped-linux-x64-abc123");
    assert.equal(diagnosticsManifest.platformId, "linux-x64");
    assert.equal(diagnosticsManifest.fileCount, 4);
    assert.deepEqual(
      diagnosticsManifest.files.map((file) => file.kind),
      ["diagnostics", "events", "process-summary", "process-samples"],
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
  } finally {
    process.env = originalEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
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
