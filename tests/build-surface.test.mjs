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
import { runLifecycle } from "../scripts/run-lifecycle-core.mjs";
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

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

test("public reusable controllers expose source-bound plan and always-aggregated receipt outputs", () => {
  const workflows = [
    ".github/workflows/check.yml",
    ".github/workflows/.build.yml",
    ".github/workflows/build.yml",
    ".github/workflows/.gate-profile.yml",
    ".github/workflows/.web-surface.yml",
    ".github/workflows/publication-artifact.yml",
    ".github/workflows/paper-release.yml",
    ".github/workflows/release-candidate-promote.yml",
    ".github/workflows/release-propagation.yml",
  ];
  for (const workflow of workflows) {
    const source = fs.readFileSync(path.join(root, workflow), "utf8");
    assert.match(source, /controller-plan-artifact:/, `${workflow} must expose its plan artifact`);
    assert.match(source, /controller-plan-digest:/, `${workflow} must expose its plan digest`);
    assert.match(source, /controller-receipt-artifact:/, `${workflow} must expose its receipt artifact`);
    assert.match(source, /controller-receipt-digest:/, `${workflow} must expose its receipt digest`);
    assert.match(source, /controller-receipt-status:/, `${workflow} must expose its receipt status`);
    assert.match(source, /BUILDCHAIN_CONTROLLER_SOURCE_SHA:/, `${workflow} must bind the consumer source SHA`);
    assert.match(source, /BUILDCHAIN_CONTROLLER_RUNTIME_SHA:/, `${workflow} must bind the Buildchain runtime SHA`);
    assert.match(source, /BUILDCHAIN_CONTROLLER_CONTRACT_DIGEST:/, `${workflow} must bind the runtime contract digest`);
    if (source.includes("BUILDCHAIN_CONTROLLER_INPUTS_JSON: ${{ toJSON(inputs) }}")) {
      assert.match(source, /BUILDCHAIN_CONTROLLER_INPUT_BOUNDARY: workflow-call/, `${workflow} must isolate caller ambient inputs`);
    }
    assert.match(source, /if: \$\{\{ always\(\)/, `${workflow} must aggregate controller outcomes with always()`);
    assert.match(source, /controller-receipt-qualifying != 'true'/, `${workflow} must fail closed on a nonqualifying receipt`);
  }

  const gateEnvelope = fs.readFileSync(path.join(root, ".github/workflows/.gate-profile.yml"), "utf8");
  assert.match(gateEnvelope, /shifu-gate-aggregate/);
  assert.doesNotMatch(gateEnvelope, /BUILDCHAIN_CONTROLLER_(?:GATE_IDS|GATE_RESULTS)/);

  const channelRouter = fs.readFileSync(path.join(root, ".github/workflows/build.yml"), "utf8");
  assert.match(channelRouter, /router-repository: \$\{\{ steps\.router\.outputs\.repository \}\}/);
  assert.match(channelRouter, /router-ref: \$\{\{ steps\.router\.outputs\.ref \}\}/);
  assert.match(channelRouter, /Checkout Buildchain controller workflow shell/);
  assert.match(channelRouter, /\.buildchain\/controller-runtime\/scripts\/controller-evidence\.mjs/);
  assert.match(channelRouter, /BUILDCHAIN_CONTROLLER_REGISTRY: \.buildchain\/controller-runtime\/dist\/site\/controller-registry\.json/);
  assert.doesNotMatch(channelRouter, /\.buildchain\/runtime\/scripts\/controller-evidence\.mjs/);

  const reusableBuild = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  assert.match(reusableBuild, /Checkout build controller workflow shell/);
  assert.match(reusableBuild, /BUILDCHAIN_CONTROLLER_RUNTIME_REF: \$\{\{ needs\.trust-gate\.outputs\.buildchain-runtime-ref \}\}/);
  assert.match(reusableBuild, /BUILDCHAIN_CONTROLLER_RUNTIME_SHA: \$\{\{ needs\.trust-gate\.outputs\.buildchain-runtime-sha \}\}/);
  assert.match(reusableBuild, /BUILDCHAIN_CONTROLLER_CONTRACT_DIGEST: \$\{\{ needs\.trust-gate\.outputs\.buildchain-contract-digest \}\}/);
  assert.doesNotMatch(reusableBuild, /BUILDCHAIN_CONTROLLER_RUNTIME_(?:REF|SHA): \$\{\{ needs\.trust-gate\.outputs\.buildchain-workflow-shell-/);
  assert.match(reusableBuild, /BUILDCHAIN_CONTROLLER_REGISTRY: \.buildchain\/controller-runtime\/dist\/site\/controller-registry\.json/);

  const paperRelease = fs.readFileSync(path.join(root, ".github/workflows/paper-release.yml"), "utf8");
  const promotion = fs.readFileSync(path.join(root, ".github/workflows/release-candidate-promote.yml"), "utf8");
  const promotionAuthority = promotion.slice(
    promotion.indexOf("  publication-authority:"),
    promotion.indexOf("\n  promote:", promotion.indexOf("  publication-authority:")),
  );
  assert.match(paperRelease, /!inputs\.dry-run.*controller-receipt-qualifying/);
  assert.match(promotion, /!inputs\.dry-run.*controller-receipt-qualifying/);
  assert.match(
    promotion,
    /"id":"publication-authority","status":"\$\{\{ needs\.promote\.result == 'success' && 'success' \|\| needs\.publication-authority\.result \}\}"/,
    "a successful promotion must preserve its already-enforced publication authority result",
  );
  assert.match(
    promotion,
    /runtime-sha: \$\{\{ steps\.controller-runtime\.outputs\.sha \}\}/,
    "promotion controller planning must expose the resolved immutable runtime SHA",
  );
  assert.match(
    promotionAuthority,
    /buildchain-ref: \$\{\{ needs\.controller-plan\.outputs\.runtime-sha \}\}/,
    "publication authority must consume the resolved immutable runtime SHA",
  );
  assert.match(
    promotionAuthority,
    /required-status-check: \$\{\{ inputs\.required-status-check \}\}/,
    "publication authority must audit the exact protected-branch status check",
  );
  assert.doesNotMatch(
    promotionAuthority,
    /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v2' \}\}/,
    "publication authority must not receive a floating caller ref",
  );
});

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
  assert.match(workflow, /setup-rust:/);
  assert.match(workflow, /rust-toolchain:/);
  assert.match(workflow, /rustup-dist-server:/);
  assert.match(workflow, /rustup-update-root:/);
  assert.match(workflow, /cargo-registry-index:/);
  assert.equal((workflow.match(/RUSTUP_DIST_SERVER:/g) || []).length, 2);
  assert.equal((workflow.match(/RUSTUP_UPDATE_ROOT:/g) || []).length, 2);
  assert.match(workflow, /https:\/\/static\.rust-lang\.org\/rustup/);
  assert.match(workflow, /Setup Rust toolchain on Windows/);
  assert.match(workflow, /if: \$\{\{ inputs\.setup-rust && runner\.os == 'Windows' \}\}/);
  assert.match(workflow, /shell: cmd/);
  assert.match(workflow, /curl\.exe --proto "=https"/);
  assert.match(workflow, /https:\/\/win\.rustup\.rs\/x86_64/);
  assert.match(workflow, /--no-modify-path/);
  assert.match(workflow, /buildchain-cargo/);
  assert.match(workflow, /buildchain-rustup/);
  assert.match(workflow, /Setup Rust toolchain/);
  assert.match(workflow, /if: \$\{\{ inputs\.setup-rust && runner\.os != 'Windows' \}\}/);
  assert.match(workflow, /dtolnay\/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30/);
  assert.match(workflow, /toolchain: \$\{\{ inputs\.rust-toolchain \}\}/);
  assert.match(
    workflow,
    /CARGO_REGISTRIES_CRATES_IO_INDEX: \$\{\{ inputs\.cargo-registry-index \}\}/,
  );
  assert.match(workflow, /container:/);
  assert.match(workflow, /require-trusted-event:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /buildchain-contract-lock-path:/);
  assert.match(workflow, /buildchain-contract-compatibility-policy:/);
  assert.match(workflow, /buildchain-contract-drift-issue-mode:/);
  assert.match(workflow, /default: ""/);
  assert.match(workflow, /Resolve Buildchain runtime/);
  assert.match(workflow, /runtime-sha/);
  assert.match(workflow, /Checkout consumer contract lock/);
  assert.match(workflow, /buildchain-contract-lock\.mjs check/);
  assert.match(workflow, /Report consumer Buildchain contract drift/);
  assert.match(workflow, /contract-lock-status=/);
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
  assert.ok(
    workflow.indexOf("Check Buildchain contract lock") <
      workflow.indexOf("build-native:"),
  );
  assert.match(workflow, /resolve-publish-source\.mjs --mode manifest/);
  assert.equal(
    (workflow.match(/Install Buildchain runtime dependencies/g) || []).length,
    5,
  );
  assert.equal(
    (workflow.match(/pnpm@11\.7\.0 install --dir \.buildchain\/runtime --prod --frozen-lockfile --ignore-scripts/g) || []).length,
    5,
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
  assert.match(workflow, /artifact-transfer-mode:/);
  assert.match(workflow, /s3-to-github-artifacts/);
  assert.match(workflow, /artifact-relay-s3-bucket:/);
  assert.match(workflow, /artifact-relay-s3-region:/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_RELAY_S3_BUCKET/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_RELAY_S3_UPLOAD_ROLE_ARN/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_RELAY_S3_DOWNLOAD_ROLE_ARN/);
  assert.match(workflow, /checkout-cache-mode:/);
  assert.match(workflow, /checkout-cache-mirror-url-template:/);
  assert.match(workflow, /checkout-cache-reference-repository-template:/);
  assert.match(workflow, /checkout-cache-fallback:/);
  assert.match(workflow, /checkout-cache-timeout-seconds:/);
  assert.match(workflow, /checkout-cache-github-timeout-seconds:/);
  assert.match(workflow, /checkout-cache-fetch-attempts:/);
  assert.match(workflow, /shifu-cache-profile-ref:/);
  assert.match(workflow, /shifu-cache-profile-digest:/);
  assert.equal(
    (workflow.match(/SHIFU_CACHE_PROFILE_REF:/g) || []).length,
    6,
  );
  assert.equal(
    (workflow.match(/SHIFU_CACHE_PROFILE_DIGEST:/g) || []).length,
    6,
  );
  assert.equal(
    (workflow.match(/BUILDCHAIN_CHECKOUT_CACHE_GITHUB_TIMEOUT_SECONDS:/g) || []).length,
    4,
  );
  assert.match(workflow, /BUILDCHAIN_CHECKOUT_CACHE_FETCH_ATTEMPTS:/);
  assert.match(workflow, /BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE/);
  assert.match(workflow, /BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE/);
  assert.equal(
    (workflow.match(/node \.buildchain\/runtime\/scripts\/locked-source-checkout\.mjs/g) || []).length,
    0,
  );
  assert.match(workflow, /buildchain-workflow-shell-sha:/);
  assert.match(workflow, /"workflow-shell-sha": workflowShellSha/);
  assert.match(workflow, /Checkout Buildchain workflow shell/);
  assert.match(workflow, /ref: \$\{\{ steps\.runtime\.outputs\.workflow-shell-sha \}\}/);
  assert.match(workflow, /path: \.buildchain\/workflow-shell\/scripts\/locked-source-checkout\.mjs/);
  assert.match(workflow, /Upload Buildchain runtime checkout bootstrap/);
  assert.equal(
    (workflow.match(/Download Buildchain runtime checkout bootstrap/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/node \.buildchain\/runtime-bootstrap\/locked-source-checkout\.mjs/g) || []).length,
    4,
  );
  assert.equal(
    (workflow.match(/BUILDCHAIN_SOURCE_CHECKOUT_PATH: \.buildchain\/runtime/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/BUILDCHAIN_SOURCE_REPOSITORY: \$\{\{ inputs\.buildchain-repository \}\}/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/BUILDCHAIN_SOURCE_CHECKOUT_DIAGNOSTICS_PATH: \.buildchain\/diagnostics\/runtime-checkout\.json/g) || []).length,
    2,
  );
  const nativeJob = workflow.slice(
    workflow.indexOf("\n  build-native:"),
    workflow.indexOf("\n  build-linux-container:"),
  );
  const containerJob = workflow.slice(
    workflow.indexOf("\n  build-linux-container:"),
    workflow.indexOf("\n  relay-artifacts:"),
  );
  assert.ok(nativeJob.indexOf("Setup Node.js") < nativeJob.indexOf("Download Buildchain runtime checkout bootstrap"));
  assert.ok(containerJob.indexOf("Setup Buildchain Node.js") < containerJob.indexOf("Download Buildchain runtime checkout bootstrap"));
  for (const job of [nativeJob, containerJob]) {
    assert.ok(job.indexOf("Download Buildchain runtime checkout bootstrap") < job.indexOf("Checkout Buildchain runtime"));
    assert.doesNotMatch(job, /Checkout Buildchain runtime\n\s+uses: actions\/checkout/);
  }
  assert.equal(
    (workflow.match(/BUILDCHAIN_SOURCE_CHECKOUT_DIAGNOSTICS_PATH: \.buildchain\/diagnostics\/source-checkout\.json/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/\.buildchain\/artifacts\/\$\{\{ matrix\.platform\.id \}\}\/source-checkout\.json/g) || []).length,
    4,
  );
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /artifact-transfer:/);
  assert.match(workflow, /artifact-relay-s3\.mjs upload/);
  assert.match(workflow, /artifact-relay-s3\.mjs download/);
  assert.match(workflow, /artifact-relay-s3\.mjs cleanup/);
  assert.match(workflow, /aws-actions\/configure-aws-credentials@v6\.1\.0/);
  assert.match(workflow, /artifact-name \}\}-relay-manifest-\$\{\{ matrix\.platform\.id \}\}-/);
  assert.match(workflow, /relay-artifacts:/);
  assert.match(workflow, /needs\.artifact-transfer\.outputs\.mode == 'github-artifacts'/);
  assert.match(workflow, /needs\.artifact-transfer\.outputs\.mode == 's3-to-github-artifacts'/);
  assert.match(workflow, /process-summary-required:/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /summary\.json/);
  assert.match(workflow, /diagnostics\.json/);
  assert.match(workflow, /diagnostics-manifest\.json/);
  assert.match(workflow, /source-checkout\.json/);
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
  assert.match(workflow, /BUILDCHAIN_CONTRACT_LOCK_PATH/);
  assert.match(workflow, /aggregate-diagnostics-summary\.mjs/);
  assert.match(workflow, /generate-release-candidate-passport\.mjs/);
  assert.match(workflow, /release-candidate-enabled/);
  assert.match(workflow, /BUILDCHAIN_RC_TARGET_CHANNEL: \$\{\{ needs\.resolve-source\.outputs\.publish-source-channel \|\| needs\.trust-gate\.outputs\.publish-channel \}\}/);
  assert.match(workflow, /BUILDCHAIN_RC_PR_BASE_REF: \$\{\{ github\.base_ref \|\| github\.event\.pull_request\.base\.ref \}\}/);
  assert.match(workflow, /release-candidate-target-channel=\$\{rc_target_channel\}/);
  assert.match(workflow, /alpha\/\*\)/);
  assert.match(workflow, /release\/\*\)/);
  assert.match(workflow, /if: \$\{\{ steps\.names\.outputs\.release-candidate-enabled == 'true' \}\}/);
  assert.match(workflow, /BUILDCHAIN_RC_TARGET_CHANNEL: \$\{\{ steps\.names\.outputs\.release-candidate-target-channel \}\}/);
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
    /BUILDCHAIN_SOURCE_SHA: \$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/,
  );
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
});

test("publication artifact workflow exposes paper artifact contract", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/publication-artifact.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /buildchain-contract-lock-path:/);
  assert.match(workflow, /buildchain-ref override is only allowed for trusted workflow_dispatch runs/);
  assert.match(workflow, /buildchain-ref override requires write, maintain, or admin permission/);
  assert.match(workflow, /BUILDCHAIN_RUNTIME_CLASS: \$\{\{ steps\.runtime\.outputs\.runtime-class \}\}/);
  assert.match(workflow, /build-command:/);
  assert.match(workflow, /toolchain-type:/);
  assert.match(workflow, /toolchain-image:/);
  assert.match(workflow, /ghcr\.io\/kungfu-systems\/build-images\/latex-pdf-builder/);
  assert.match(workflow, /toolchain-digest:/);
  assert.match(workflow, /sha256:c20f3809e96836c1c78e97c76939d12f1de3fed0ea9b7c40c43332ec2ea480f8/);
  assert.match(workflow, /Resolve publication toolchain/);
  assert.match(workflow, /docker pull/);
  assert.match(workflow, /BUILDCHAIN_PUBLICATION_TOOLCHAIN_TYPE/);
  assert.match(workflow, /verify-command:/);
  assert.match(workflow, /publication-artifact manifest/);
  assert.match(workflow, /publication-artifact-passport\.json/);
  assert.match(workflow, /publication-registry\.json/);
  assert.match(workflow, /publication-registry-path:/);
  assert.match(workflow, /registry-path=\$\{result\.registryPath \|\| ""\}/);
  assert.match(workflow, /source\.tar\.gz/);
  assert.match(workflow, /Upload publication artifact[\s\S]*include-hidden-files: true/);
  assert.ok(
    workflow.indexOf("Check Buildchain contract lock") <
      workflow.indexOf("- name: Build publication"),
  );
  assert.ok(
    workflow.indexOf("- name: Verify publication") <
      workflow.indexOf("Collect publication artifact manifest"),
  );
});

test("paper release workflow publishes declared npm package with source lock and GitHub Release", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/paper-release.yml"),
    "utf8",
  );
  const docs = fs.readFileSync(
    path.join(root, "docs/publication-artifacts.md"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /buildchain-contract-lock-path:/);
  assert.match(workflow, /BUILDCHAIN_RUNTIME_CLASS: \$\{\{ steps\.runtime\.outputs\.runtime-class \}\}/);
  assert.match(workflow, /toolchain-type:/);
  assert.match(workflow, /ghcr\.io\/kungfu-systems\/build-images\/latex-pdf-builder/);
  assert.match(workflow, /publication-artifact manifest/);
  assert.match(workflow, /publication-artifact npm-package/);
  assert.match(workflow, /path\.resolve\(process\.cwd\(\), result\.outputDir\)/);
  assert.match(workflow, /write\("package-dir", result\.outputDir\)/);
  assert.match(workflow, /npm pack --dry-run/);
  assert.match(workflow, /publish-required-artifacts-json: \$\{\{ steps\.package\.outputs\.publish-required-artifacts-json \}\}/);
  assert.match(workflow, /publish-command: >-/);
  assert.match(workflow, /scripts\/npm-publish-transaction\.mjs/);
  assert.match(workflow, /publish-mode: "publish-final-version"/);
  assert.match(workflow, /publish-auth: "trusted-publishing"/);
  assert.match(workflow, /publish-dist-tag: \$\{\{ steps\.package\.outputs\.dist-tag \}\}/);
  assert.match(workflow, /Ensure publish-gate ref locks promotion commit/);
  assert.match(workflow, /publish-gate\/\$\{channel\}/);
  assert.match(workflow, /require-publish-source-lock: "true"/);
  assert.match(workflow, /publish-source-ref: \$\{\{ steps\.publish-gate\.outputs\.ref \}\}/);
  assert.match(workflow, /publish-source-sha: \$\{\{ steps\.publish-gate\.outputs\.sha \}\}/);
  assert.match(workflow, /publish-source-locked: \$\{\{ steps\.publish-gate\.outputs\.locked \}\}/);
  assert.match(workflow, /release-passport-product-name: \$\{\{ inputs\.release-passport-product-name \|\| steps\.package\.outputs\.package-name \}\}/);
  assert.match(workflow, /github-release:/);
  assert.match(workflow, /github-release: \$\{\{ inputs\.github-release \}\}/);
  assert.match(workflow, /publicationManifest\.artifacts/);
  assert.match(workflow, /writeMultiline\("github-release-artifact-paths", releaseArtifactPaths\)/);
  assert.match(workflow, /github-release-artifact-paths: \$\{\{ steps\.package\.outputs\.github-release-artifact-paths \}\}/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /name: Seal paper publication capability/);
  assert.match(
    workflow,
    /name: Seal paper publication capability\n    permissions:\n      actions: read\n      contents: read/,
  );
  assert.match(workflow, /permissions:\n      checks: write\n      contents: write\n      id-token: write/);
  assert.doesNotMatch(workflow, /^ {4}environment\s*:/m);
  assert.match(workflow, /Preflight protected publication authority/);
  assert.match(
    workflow,
    /github-token: \$\{\{ github\.token \}\}/,
  );
  assert.match(workflow, /cannot read branch protection before publication build/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  assert.match(docs, /paper-release-sealed\.yml@v2/);
  assert.match(docs, /does not use a long-lived token for npm publication/);
  assert.match(docs, /only for machine-generated[\s\S]*version-state updates/);
  assert.match(workflow, /default: true/);
  assert.ok(
    workflow.indexOf("Check Buildchain contract lock") <
      workflow.indexOf("- name: Build publication"),
  );
  assert.ok(
    workflow.indexOf("Preflight protected publication authority") <
      workflow.indexOf("- name: Build publication"),
  );
  assert.ok(
    workflow.indexOf("- name: Prepare npm paper package") <
      workflow.indexOf("- name: Publish paper package"),
  );
});

test("artifact relay uploads to S3 and downloads verified GitHub artifact payloads without aws cli", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-artifact-relay-"));
  const fakeS3Root = path.join(workspace, "fake-s3");
  fs.mkdirSync(path.join(workspace, "dist"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".buildchain", "artifacts", "linux-x64"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "dist", "package.tgz"), "payload\n");
  fs.writeFileSync(path.join(workspace, ".buildchain", "artifacts", "linux-x64", "manifest.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, ".buildchain", "artifacts", "linux-x64", "summary.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, ".buildchain", "artifacts", "linux-x64", "diagnostics.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, ".buildchain", "artifacts", "linux-x64", "diagnostics-manifest.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, ".buildchain", "artifacts", "linux-x64", "events.jsonl"), "");

  const oldPath = process.env.PATH;
  const oldFakeRoot = process.env.BUILDCHAIN_ARTIFACT_RELAY_FAKE_S3_ROOT;
  process.env.PATH = "";
  process.env.BUILDCHAIN_ARTIFACT_RELAY_FAKE_S3_ROOT = fakeS3Root;
  try {
    const manifest = await uploadRelayArtifacts({
      workspace,
      manifestPath: ".buildchain/artifacts/linux-x64/relay-manifest.json",
      bucket: "relay-bucket",
      region: "cn-north-1",
      prefix: "unit",
      repository: "kungfu-systems/libnode",
      runId: "123",
      runAttempt: "1",
      sourceSha: "a".repeat(40),
      platformId: "linux-x64",
      platformName: "Linux x64",
      groups: [
        {
          role: "payload",
          artifactName: "libnode-linux-x64",
          paths: ["dist", ".buildchain/artifacts/linux-x64/manifest.json"],
          required: true,
        },
        {
          role: "manifest",
          artifactName: "libnode-manifest-linux-x64",
          paths: [
            ".buildchain/artifacts/linux-x64/manifest.json",
            ".buildchain/artifacts/linux-x64/summary.json",
            ".buildchain/artifacts/linux-x64/diagnostics.json",
          ],
          required: true,
        },
        {
          role: "diagnostics",
          artifactName: "libnode-diagnostics-linux-x64",
          paths: [
            ".buildchain/artifacts/linux-x64/diagnostics.json",
            ".buildchain/artifacts/linux-x64/diagnostics-manifest.json",
            ".buildchain/artifacts/linux-x64/events.jsonl",
          ],
          required: true,
        },
      ],
    });
    assert.equal(manifest.contract, "kungfu-buildchain-artifact-relay-s3");
    assert.equal(manifest.groups.length, 3);
    assert.ok(fs.existsSync(path.join(fakeS3Root, "relay-bucket")));

    const download = await downloadRelayArtifacts({
      inputRoot: path.join(workspace, ".buildchain", "artifacts", "linux-x64"),
      outputRoot: path.join(workspace, "relayed"),
      region: "cn-north-1",
      platformId: "linux-x64",
    });
    assert.equal(download.objectCount, manifest.groups.reduce((sum, group) => sum + group.fileCount, 0));
    assert.equal(
      fs.readFileSync(path.join(workspace, "relayed", "payload", "dist", "package.tgz"), "utf8"),
      "payload\n",
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, "relayed", "manifest", ".buildchain", "artifacts", "linux-x64", "manifest.json"), "utf8"),
      "{}\n",
    );
    const cleanup = await cleanupRelayArtifacts({
      inputRoot: path.join(workspace, ".buildchain", "artifacts", "linux-x64"),
      region: "cn-north-1",
      platformId: "linux-x64",
    });
    assert.equal(cleanup.objectCount, download.objectCount);
    const remainingObjects = fs
      .readdirSync(path.join(fakeS3Root, "relay-bucket"), { recursive: true })
      .filter((entry) => fs.statSync(path.join(fakeS3Root, "relay-bucket", entry)).isFile());
    assert.deepEqual(remainingObjects, []);
  } finally {
    process.env.PATH = oldPath;
    if (oldFakeRoot === undefined) {
      delete process.env.BUILDCHAIN_ARTIFACT_RELAY_FAKE_S3_ROOT;
    } else {
      process.env.BUILDCHAIN_ARTIFACT_RELAY_FAKE_S3_ROOT = oldFakeRoot;
    }
  }
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
  assert.match(workflow, /buildchain-contract-lock-path:/);
  assert.match(workflow, /buildchain-contract-drift-issue-mode:/);
  assert.match(workflow, /Resolve checked out Buildchain runtime/);
  assert.match(workflow, /Check Buildchain contract lock/);
  assert.match(workflow, /Report consumer Buildchain contract drift/);
  assert.match(workflow, /allow-repository:/);
  assert.match(workflow, /default: ""/);
  assert.match(workflow, /required-status-check:/);
  assert.match(
    workflow,
    /required-status-check:\n\s+description: "Exact required protected-branch status check context"\n\s+default: "check \/ check"/,
  );
  assert.match(workflow, /target-sha:/);
  assert.match(workflow, /publish-mode:/);
  assert.match(workflow, /publish-dist-tag:/);
  assert.match(workflow, /publish-package-set-order:/);
  assert.match(workflow, /publish-package-main:/);
  assert.match(workflow, /github-release:/);
  assert.match(workflow, /github-release:\n\s+description: "Create\/update the public GitHub Release and upload Buildchain release passport\/evidence assets after a complete release transaction"\n\s+default: true/);
  assert.match(workflow, /github-release-title:/);
  assert.match(workflow, /github-release-notes:/);
  assert.match(workflow, /release-passport-product-name:/);
  assert.match(workflow, /release-passport-impact-json:/);
  assert.match(workflow, /release-passport-impact-json: \$\{\{ inputs\.release-passport-impact-json \}\}/);
  assert.match(workflow, /release-passport-kfd-1-witness-jsons:/);
  assert.match(workflow, /release-passport-kfd-1-witness-jsons: \$\{\{ inputs\.release-passport-kfd-1-witness-jsons \}\}/);
  assert.match(workflow, /release-passport-kfd-2-claim-jsons:/);
  assert.match(workflow, /release-passport-kfd-2-claim-jsons: \$\{\{ inputs\.release-passport-kfd-2-claim-jsons \}\}/);
  assert.match(workflow, /release-passport-kfd-3-prebuild-witness-jsons:/);
  assert.match(workflow, /release-passport-kfd-3-prebuild-witness-jsons: \$\{\{ inputs\.release-passport-kfd-3-prebuild-witness-jsons \}\}/);
  assert.match(workflow, /release-passport-kfd-3-artifact-witness-jsons:/);
  assert.match(workflow, /release-passport-kfd-3-artifact-witness-jsons: \$\{\{ inputs\.release-passport-kfd-3-artifact-witness-jsons \}\}/);
  assert.match(workflow, /release-passport-kfd-3-artifact-verify-command:/);
  assert.match(workflow, /release-passport-buildchain-self-kfd:/);
  assert.match(workflow, /release-passport-buildchain-self-kfd: \$\{\{ inputs\.release-passport-buildchain-self-kfd \}\}/);
  assert.match(workflow, /DRY_RUN: \$\{\{ inputs\.dry-run \}\}/);
  assert.match(workflow, /const dryRun = process\.env\.DRY_RUN === "true"/);
  assert.match(workflow, /if \(dryRun\) \{\s+core\.notice\(`Dry-run would lock/);
  assert.match(workflow, /core\.setOutput\("locked", "true"\)/);
  assert.match(workflow, /require-publish-source-lock: "true"/);
  assert.match(workflow, /publish-source-ref: \$\{\{ steps\.publish-gate\.outputs\.ref \}\}/);
  assert.match(workflow, /publish-source-sha: \$\{\{ steps\.publish-gate\.outputs\.sha \}\}/);
  assert.match(workflow, /publish-source-locked: \$\{\{ steps\.publish-gate\.outputs\.locked \}\}/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_NAME: \$\{\{ inputs\.artifact-name \}\}/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_PATTERNS: \$\{\{ inputs\.artifact-patterns \}\}/);
  assert.match(workflow, /BUILDCHAIN_RC_WORKFLOW_FILE: \$\{\{ inputs\.release-candidate-workflow-file \}\}/);
  assert.match(workflow, /BUILDCHAIN_RC_WORKFLOW_NAME: \$\{\{ inputs\.release-candidate-workflow-name \}\}/);
  assert.match(workflow, /BUILDCHAIN_REQUIRED_ARTIFACT_COUNT: \$\{\{ inputs\.required-artifact-count \}\}/);
  assert.match(workflow, /BUILDCHAIN_PUBLISH_PACKAGE_MAIN: \$\{\{ inputs\.publish-package-main \}\}/);
  assert.match(workflow, /concurrency:\n\s+group: buildchain-release-promotion-\$\{\{ github\.repository \}\}\n\s+cancel-in-progress: false/);
  assert.match(workflow, /name: Revalidate promotion intent/);
  assert.match(workflow, /name: Revalidate queued promotion intent/);
  assert.match(workflow, /name: Preflight PR-stage release candidate evidence/);
  assert.match(workflow, /name: Plan exact publication version/);
  assert.match(workflow, /name: Install exact publication planning dependencies/);
  const publicationPlanStart = workflow.indexOf("  publication-plan:");
  const publicationAuthorityStart = workflow.indexOf("  publication-authority:");
  const publicationPlan = workflow.slice(publicationPlanStart, publicationAuthorityStart);
  assert.ok(
    publicationPlan.indexOf("name: Install exact publication planning dependencies") <
      publicationPlan.indexOf("name: Resolve exact publication transaction version"),
    "exact publication planning must install source dependencies before version-state verification",
  );
  assert.match(publicationPlan, /corepack pnpm@11\.7\.0 install --frozen-lockfile/);
  assert.match(publicationPlan, /yarn install --immutable \|\| yarn install --frozen-lockfile/);
  assert.match(publicationPlan, /npm ci/);
  assert.match(publicationPlan, /Skipping dependency install for custom package manager/);
  assert.match(workflow, /planned-publication-version/);
  assert.match(workflow, /publication-version: \$\{\{ needs\.publication-plan\.outputs\.version \}\}/);
  assert.match(workflow, /PUBLICATION_VERSION: \$\{\{ needs\.publication-plan\.outputs\.version \}\}/);
  assert.match(workflow, /expected-publication-version: \$\{\{ needs\.publication-plan\.outputs\.version \}\}/);
  assert.match(workflow, /BUILDCHAIN_RC_DOWNLOAD: "false"/);
  assert.match(workflow, /failure\(\) && !inputs\.dry-run && steps\.rc\.outcome != ''/);
  assert.match(workflow, /compareCommitsWithBasehead/);
  assert.match(workflow, /const superseded = !dryRun && comparisonStatus === "ahead"/);
  assert.match(workflow, /moved incompatibly/);
  assert.match(workflow, /const action = superseded \? "noop" : "promote"/);
  assert.match(workflow, /const reason = superseded \? "target-ref-advanced" : "target-ref-current"/);
  assert.match(workflow, /publication-admission-json:/);
  assert.match(workflow, /publication-control-plane-audit-json:/);
  assert.match(workflow, /publication-gate-aggregate-json:/);
  assert.match(workflow, /publication-auto-admission:/);
  assert.match(workflow, /auto-admission: \$\{\{ inputs\.publication-auto-admission \}\}/);
  assert.match(workflow, /publication-auto-no-gate:/);
  assert.match(workflow, /auto-no-gate: \$\{\{ inputs\.publication-auto-no-gate \}\}/);
  assert.match(workflow, /source-sha: \$\{\{ needs\.preflight\.outputs\.requested-sha \}\}/);
  assert.match(workflow, /publisher-workflow-path: \$\{\{ inputs\.publication-publisher-workflow-path \}\}/);
  assert.match(workflow, /evidence-run-id:/);
  assert.match(workflow, /evidence-manifest-pattern:/);
  assert.match(workflow, /name: Seal product publication capability/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/\.publication-authority\.yml/);
  assert.match(workflow, /needs: \[preflight, controller-plan, release-candidate-preflight, publication-plan, publication-authority, publication-qualification\]/);
  assert.match(workflow, /needs\.publication-authority\.result == 'success'/);
  assert.match(workflow, /name: Bind consumer publication predicate/);
  assert.match(workflow, /name: Run consumer publication predicate/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /BUILDCHAIN_PUBLICATION_GATE_AGGREGATE_PATH/);
  assert.match(workflow, /BUILDCHAIN_PUBLICATION_QUALIFICATION_RESULT_PATH/);
  assert.match(workflow, /createPublicationQualificationReceipt/);
  assert.ok(
    workflow.indexOf("Run consumer-owned qualification predicate") <
      workflow.indexOf("Restore sealed handoff before receipt sealing") &&
      workflow.indexOf("Restore sealed handoff before receipt sealing") <
        workflow.indexOf("Seal deterministic qualification receipt"),
    "consumer code must not be able to replace the authority handoff used for receipt sealing",
  );
  assert.match(workflow, /require-publication-qualification: \$\{\{ needs\.publication-qualification\.outputs\.required \}\}/);
  assert.match(workflow, /publication-qualification-receipt-json: \$\{\{ needs\.publication-qualification\.outputs\.receipt-json \}\}/);
  assert.doesNotMatch(workflow, /^ {4}environment\s*:/m);
  assert.match(workflow, /token: \$\{\{ github\.token \}\}/);
  assert.match(
    workflow,
    /generated-ref-update-token: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \|\| github\.token \}\}/,
  );
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  assert.match(workflow, /if: \$\{\{ needs\.preflight\.outputs\.action == 'promote' \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.preflight\.outputs\.requested-sha \}\}/);
  assert.match(workflow, /INPUT_TARGET_SHA: \$\{\{ inputs\.target-sha \}\}/);
  assert.match(workflow, /Install promotion dependencies/);
  assert.match(workflow, /PACKAGE_MANAGER: \$\{\{ inputs\.package-manager \}\}/);
  assert.match(workflow, /corepack enable/);
  assert.match(workflow, /corepack pnpm@11\.7\.0 install --frozen-lockfile/);
  assert.match(workflow, /Resolve post-release reconciliation checkout/);
  assert.match(workflow, /Checkout current development channel for reconciliation/);
  assert.match(workflow, /Install reconciliation dependencies/);
  assert.match(workflow, /workspace=\.buildchain\/reconciliation\/dev/);
  assert.match(workflow, /reconciliation-workspace: \$\{\{ steps\.reconciliation\.outputs\.workspace \}\}/);
  assert.match(workflow, /promote-only-release-candidate: "true"/);
  assert.match(workflow, /release-candidate-passport-path:/);
  assert.match(workflow, /release-candidate-build-summary-path:/);
  assert.match(workflow, /required-status-check: \$\{\{ inputs\.required-status-check \}\}/);
  assert.match(workflow, /allow-repository: \$\{\{ inputs\.allow-repository \|\| github\.repository \}\}/);
  assert.match(workflow, /publish-required-artifacts-json: \$\{\{ inputs\.publish-required-artifacts-json \|\| steps\.rc\.outputs\.publish-required-artifacts-json \}\}/);
  assert.match(workflow, /publish-dist-tag: \$\{\{ inputs\.publish-dist-tag \}\}/);
  assert.match(workflow, /publish-package-set-order: \$\{\{ inputs\.publish-package-set-order \}\}/);
  assert.match(workflow, /release-passport-platform-manifest-paths: \$\{\{ inputs\.release-passport-platform-manifest-paths \|\| steps\.rc\.outputs\.release-candidate-platform-manifest-paths \}\}/);
  assert.match(workflow, /github-release: \$\{\{ inputs\.github-release \}\}/);
  assert.match(workflow, /github-release-title: \$\{\{ inputs\.github-release-title \}\}/);
  assert.match(workflow, /github-release-notes: \$\{\{ inputs\.github-release-notes \}\}/);
  assert.match(workflow, /Ensure publish-gate ref locks promotion commit/);
  assert.match(workflow, /id: promote/);
  assert.ok(
    workflow.indexOf("Revalidate queued promotion intent") <
      workflow.indexOf("Install promotion dependencies"),
  );
  assert.ok(
    workflow.indexOf("Preflight PR-stage release candidate evidence") <
      workflow.indexOf("Install promotion dependencies"),
  );
  assert.ok(
    workflow.indexOf("Seal product publication capability") <
      workflow.indexOf("Install promotion dependencies"),
  );
  assert.ok(
    workflow.indexOf("Run consumer-owned qualification predicate") <
      workflow.indexOf("Ensure publish-gate ref locks promotion commit"),
  );
  assert.ok(
    workflow.indexOf("Revalidate queued promotion intent") <
      workflow.indexOf("Resolve PR-stage release candidate"),
  );
  assert.ok(
    workflow.indexOf("Revalidate queued promotion intent") <
      workflow.indexOf("Ensure publish-gate ref locks promotion commit"),
  );
  assert.doesNotMatch(workflow, /Publish GitHub Release evidence/);
  assert.doesNotMatch(workflow, /gh release upload/);
  assert.doesNotMatch(workflow, /\.github\/workflows\/\.build\.yml/);
  assert.doesNotMatch(workflow, /build-native:/);
  assert.doesNotMatch(workflow, /build-linux-container:/);
  assert.doesNotMatch(workflow, /fromJSON\(needs\.resolve-contract\.outputs/);
});

test("sealed publication authority verifier is independent and credential-free", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.publication-authority.yml"),
    "utf8",
  );
  assert.match(workflow, /name: Independently verify publication admission/);
  assert.match(workflow, /verifyPublicationAdmission/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|BUILDCHAIN_PROMOTION_TOKEN/);
  assert.match(workflow, /BUILDCHAIN_USED_NONCES_JSON/);
  assert.match(workflow, /gate-aggregate-json=/);
  assert.match(workflow, /consumer-qualification-required:/);
  assert.match(workflow, /name: Require complete sealed publication evidence/);
  assert.match(workflow, /Sealed publication evidence unavailable/);
  assert.match(workflow, /npm Trusted Publishing and OIDC were not evaluated/);
  assert.ok(
    workflow.indexOf("Require complete sealed publication evidence") <
      workflow.indexOf("Download exact release-candidate passport evidence"),
  );
  assert.match(workflow, /Download exact release-candidate passport evidence/);
  assert.match(workflow, /Download referenced controller receipt evidence/);
  assert.match(workflow, /Download exact artifact manifest evidence/);
  assert.match(workflow, /git\/commits\/\$\{admission\.sourceSha\}/);
  assert.match(workflow, /releaseCandidatePassport:/);
  assert.match(workflow, /controllerReceipt:/);
  assert.match(workflow, /artifactManifests(?:,|:)/);
  assert.match(workflow, /artifactPayloads:/);
  assert.match(workflow, /name: Restrict automatic admission to declared managed publication surfaces/);
  assert.match(workflow, /release-candidate admission evidence must belong to the caller repository/);
  assert.match(workflow, /release-candidate admission requires a repository-local publisher workflow path/);
  assert.match(workflow, /release-candidate admission requires a Gate aggregate or explicit publication-auto-no-gate decision/);
  assert.match(workflow, /name: Audit managed release-candidate publication control plane/);
  assert.match(workflow, /--repository "\$\{\{ inputs\.evidence-repository \}\}"/);
  assert.match(workflow, /--workflow-repository "\$\{\{ inputs\.buildchain-repository \}\}"/);
  assert.match(workflow, /--source-sha "\$\{\{ inputs\.source-sha \}\}"/);
  assert.match(workflow, /--workflow-ref "\$\{\{ inputs\.buildchain-ref \}\}"/);
  assert.match(workflow, /name: Assemble managed release-candidate admission/);
  assert.match(workflow, /BUILDCHAIN_PLANNED_PUBLICATION_VERSION/);
  assert.match(workflow, /authority publication version mismatch/);
  assert.match(
    workflow,
    /const capabilityQualificationRequired = capability\.qualification\?\.required === true;/,
  );
  assert.match(
    workflow,
    /capabilityQualificationRequired !== qualificationRequired/,
  );
  assert.match(workflow, /steps\.auto-evidence\.outputs\.admission-json/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
});

test("self-publication admission assembly binds downloaded evidence without publication credentials", () => {
  const script = fs.readFileSync(
    path.join(root, "scripts/assemble-self-publication-admission.mjs"),
    "utf8",
  );
  assert.match(script, /createPublicationArtifactManifestSet/);
  assert.match(script, /createPublicationGateDecision/);
  assert.match(script, /createRunnerProvenance/);
  assert.match(script, /createPublicationAdmission/);
  assert.match(script, /required\("BUILDCHAIN_PUBLICATION_VERSION"\)/);
  assert.match(script, /admitted source tree does not match release candidate/);
  assert.match(script, /BUILDCHAIN_ALLOW_NO_GATE/);
  assert.match(script, /managed-release-candidate-no-gate/);
  assert.match(script, /github-hosted-single-job/);
  assert.doesNotMatch(script, /NODE_AUTH_TOKEN|NPM_TOKEN|BUILDCHAIN_PROMOTION_TOKEN/);
});

test("publication control-plane audit defers npm OIDC authorization to the publish transaction", () => {
  const script = fs.readFileSync(
    path.join(root, "scripts/audit-publication-control-plane.mjs"),
    "utf8",
  );
  assert.match(script, /provider-at-transaction/);
  assert.match(script, /authorizationDeferred: true/);
  assert.match(script, /configurationRead: false/);
  assert.match(script, /workflowRef \? `\?ref=\$\{encodeURIComponent\(workflowRef\)\}`/);
  assert.match(script, /evidenceSource: "exact-workflow-source"/);
  assert.match(script, /evidenceSource: "exact-workflow-job"/);
  assert.match(script, /policyMode: "provider-enforced-transaction"/);
  assert.match(script, /source pull-request lineage/);
  assert.doesNotMatch(script, /actions\/permissions\/workflow/);
  assert.doesNotMatch(script, /actions\/runners\?per_page/);
  assert.doesNotMatch(script, /\["trust", "list"/);
  assert.match(script, /\^\\s\*\(\?:NODE_AUTH_TOKEN\|NPM_TOKEN\|npm-token/);
  assert.doesNotMatch(script, /= \/NODE_AUTH_TOKEN\|NPM_TOKEN\|npm-token\|/);
});

test("legacy release workflows fail closed instead of bypassing publish-gate source locks", () => {
  const retiredReleaseWorkflows = [
    ".release-new-version.yml",
    ".release-elastic-beanstalk.yml",
    ".sam-release.yml",
    ".wheel-release.yml",
  ];
  for (const workflowName of retiredReleaseWorkflows) {
    const workflow = fs.readFileSync(
      path.join(root, ".github/workflows", workflowName),
      "utf8",
    );
    assert.match(workflow, /release path is retired/);
    assert.match(workflow, /release-candidate-promote\.yml@v2/);
    assert.match(workflow, /publish-gate source-lock enforcement/);
    assert.doesNotMatch(workflow, /npm publish --access=public/);
    assert.doesNotMatch(workflow, /actions\/publish-prebuilt@v2/);
    assert.doesNotMatch(workflow, /actions\/bump-version@v2/);
    assert.doesNotMatch(workflow, /beanstalk-deploy@/);
    assert.doesNotMatch(workflow, /sam deploy/);
  }
});

test("dev PR auto-merge workflow exposes protected dev policy gates", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/dev-pr-auto-merge.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /target-branch:/);
  assert.match(workflow, /required-status-checks:/);
  assert.match(workflow, /default: "check \/ check"/);
  assert.match(workflow, /ready-label:/);
  assert.match(workflow, /block-labels:/);
  assert.match(workflow, /allowed-head-prefixes:/);
  assert.match(workflow, /require-approval:/);
  assert.match(workflow, /same-repository-only:/);
  assert.match(workflow, /max-merges:/);
  assert.match(workflow, /dry-run:/);
  assert.match(workflow, /default: true/);
  assert.match(workflow, /dev\/v\*\/v\*/);
  assert.match(workflow, /Checkout Buildchain runtime/);
  assert.match(workflow, /dev-pr-auto-merge\.mjs/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /checks: read/);
  assert.match(workflow, /statuses: read/);
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
});

test("patrol workflow family exposes daily weekly monthly reusable entries and dogfood schedules", () => {
  const engine = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-patrol.yml"),
    "utf8",
  );
  const daily = fs.readFileSync(
    path.join(root, ".github/workflows/patrol-daily.yml"),
    "utf8",
  );
  const weekly = fs.readFileSync(
    path.join(root, ".github/workflows/patrol-weekly.yml"),
    "utf8",
  );
  const monthly = fs.readFileSync(
    path.join(root, ".github/workflows/patrol-monthly.yml"),
    "utf8",
  );
  const dogfoodDaily = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-patrol-daily.yml"),
    "utf8",
  );
  const dogfoodWeekly = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-patrol-weekly.yml"),
    "utf8",
  );
  const dogfoodMonthly = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-patrol-monthly.yml"),
    "utf8",
  );

  assert.match(engine, /workflow_call:/);
  assert.match(engine, /cadence:/);
  assert.match(engine, /mode:/);
  assert.match(engine, /capabilities:/);
  assert.match(engine, /buildchain-patrol\.mjs/);
  assert.match(engine, /BUILDCHAIN_PATROL_CADENCE: \$\{\{ inputs\.cadence \}\}/);
  assert.match(engine, /BUILDCHAIN_PATROL_DRY_RUN: \$\{\{ inputs\.dry-run \}\}/);
  assert.match(engine, /actions\/upload-artifact@v7\.0\.1/);

  assert.match(daily, /workflow_call:/);
  assert.match(daily, /required-status-checks:\n\s+description: [^\n]+\n\s+default: "check \/ check"/);
  assert.match(daily, /cadence: daily/);
  assert.match(daily, /mode: cadence-default/);
  assert.match(daily, /max-actions:/);
  assert.match(daily, /contents: write/);
  assert.match(daily, /pull-requests: write/);
  assert.match(weekly, /workflow_call:/);
  assert.match(weekly, /cadence: weekly/);
  assert.match(weekly, /contents: write/);
  assert.match(weekly, /pull-requests: write/);
  assert.match(monthly, /workflow_call:/);
  assert.match(monthly, /cadence: monthly/);
  assert.match(monthly, /contents: write/);
  assert.match(monthly, /pull-requests: write/);

  assert.match(dogfoodDaily, /schedule:/);
  assert.match(dogfoodDaily, /uses: \.\/\.github\/workflows\/patrol-daily\.yml/);
  assert.match(dogfoodDaily, /required-status-checks: check/);
  assert.match(dogfoodDaily, /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v2' \}\}/);
  assert.doesNotMatch(dogfoodDaily, /target-branch: dev\/v2\/v2\.\d+/);
  assert.match(dogfoodDaily, /dry-run: \$\{\{ inputs\.dry-run \|\| false \}\}/);
  assert.match(dogfoodDaily, /contents: write/);
  assert.match(dogfoodDaily, /pull-requests: write/);
  assert.match(dogfoodWeekly, /schedule:/);
  assert.match(dogfoodWeekly, /uses: \.\/\.github\/workflows\/patrol-weekly\.yml/);
  assert.match(dogfoodWeekly, /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v2' \}\}/);
  assert.doesNotMatch(dogfoodWeekly, /target-branch: dev\/v2\/v2\.\d+/);
  assert.match(dogfoodWeekly, /contents: write/);
  assert.match(dogfoodWeekly, /pull-requests: write/);
  assert.match(dogfoodMonthly, /schedule:/);
  assert.match(dogfoodMonthly, /uses: \.\/\.github\/workflows\/patrol-monthly\.yml/);
  assert.match(dogfoodMonthly, /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v2' \}\}/);
  assert.doesNotMatch(dogfoodMonthly, /target-branch: dev\/v2\/v2\.\d+/);
  assert.match(dogfoodMonthly, /contents: write/);
  assert.match(dogfoodMonthly, /pull-requests: write/);
});

test("stable candidate patrol persists exact candidates and uses source-lock PR promotion", () => {
  const reusable = fs.readFileSync(
    path.join(root, ".github/workflows/stable-candidate-patrol.yml"),
    "utf8",
  );
  const dogfood = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-stable-candidate-patrol.yml"),
    "utf8",
  );
  const qualification = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-stable-candidate-qualification.yml"),
    "utf8",
  );
  const implementation = fs.readFileSync(
    path.join(root, "scripts/stable-candidate-patrol.mjs"),
    "utf8",
  );
  const ledger = fs.readFileSync(
    path.join(root, "packages/core/stable-candidate-ledger.js"),
    "utf8",
  );

  assert.match(reusable, /workflow_call:/);
  assert.match(reusable, /release-now:/);
  assert.match(reusable, /auto-promote:/);
  assert.match(reusable, /auto-merge:/);
  assert.match(reusable, /approval-token:/);
  assert.match(reusable, /GH_TOKEN: \$\{\{ secrets\.approval-token \|\| github\.token \}\}/);
  assert.match(reusable, /BUILDCHAIN_STABLE_REVOKED_ALPHA_VERSIONS/);
  assert.match(reusable, /stable-candidate-policy\.mjs/);
  assert.match(reusable, /stable-candidate-patrol\.mjs/);
  assert.match(reusable, /cancel-in-progress: false/);
  assert.match(ledger, /publish-gate\/release/);
  assert.match(implementation, /BUILDCHAIN_STABLE_RELEASE_NOW/);
  assert.match(dogfood, /cron: "0 19 \* \* \*"/);
  assert.match(dogfood, /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v2-alpha' \}\}/);
  assert.match(dogfood, /promotion-token: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \}\}/);
  assert.match(
    dogfood,
    /approval-token: \$\{\{ secrets\.BUILDCHAIN_APPROVAL_TOKEN \|\| secrets\.KUNGFU_GITHUB_TOKEN \}\}/,
  );
  assert.match(qualification, /workflows: \["Buildchain Alpha Self-Dogfood"\]/);
  assert.match(qualification, /statuses: write/);
  assert.match(qualification, /GITHUB_TOKEN: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \}\}/);
  assert.match(qualification, /BUILDCHAIN_QUALIFICATION_ATTESTATION_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(qualification, /stable-candidate-qualification\.mjs/);
});

test("check workflow preserves verify mode and exposes source-check mode", () => {
  const reusable = fs.readFileSync(
    path.join(root, ".github/workflows/check.yml"),
    "utf8",
  );
  const verify = fs.readFileSync(
    path.join(root, ".github/workflows/verify.yml"),
    "utf8",
  );

  assert.match(reusable, /workflow_call:/);
  assert.match(reusable, /mode:/);
  assert.match(reusable, /default: "verify"/);
  assert.match(reusable, /runs-on: ubuntu-24\.04/);
  assert.match(reusable, /fetch-depth: \$\{\{ inputs\.mode == 'source' && '0' \|\| '1' \}\}/);
  assert.match(reusable, /persist-credentials: false/);
  assert.match(reusable, /Run declared install lifecycle/);
  assert.match(reusable, /lifecycle run install/);
  assert.match(reusable, /verify\) stage="verify"/);
  assert.match(reusable, /source\) stage="check"/);
  assert.match(reusable, /--require-lifecycle-stages install,\$\{\{ steps\.lifecycle\.outputs\.stage \}\}/);
  assert.match(reusable, /lifecycle run \$\{\{ steps\.lifecycle\.outputs\.stage \}\}/);
  assert.equal(
    (reusable.match(/BUILDCHAIN_CHECK_MODE: \$\{\{ inputs\.mode \}\}/g) || []).length,
    3,
  );
  assert.match(reusable, /if: \$\{\{ inputs\.upload-artifacts \}\}/);
  const lifecycleDocs = fs.readFileSync(
    path.join(root, "docs/lifecycle-protocol.md"),
    "utf8",
  );
  assert.match(lifecycleDocs, /BUILDCHAIN_CHECK_MODE=source/);
  assert.match(lifecycleDocs, /BUILDCHAIN_CHECK_MODE=verify/);
  assert.match(verify, /Checkout Buildchain runtime/);
  assert.match(verify, /Validate declared check lifecycle/);
  assert.match(verify, /lifecycle run install/);
  assert.match(verify, /lifecycle run verify/);
});

test("source-check fixture executes only install and check", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-source-check-"));
  fs.cpSync(path.join(root, "fixtures/source-check-shaped"), workspace, { recursive: true });

  const previousMode = process.env.BUILDCHAIN_CHECK_MODE;
  process.env.BUILDCHAIN_CHECK_MODE = "source";
  try {
    runLifecycle({
      cwd: workspace,
      workspace,
      stageName: "install",
      required: true,
      manifestPath: ".buildchain/artifacts/install-manifest.json",
      summaryPath: ".buildchain/artifacts/install-summary.json",
    });
    runLifecycle({
      cwd: workspace,
      workspace,
      stageName: "check",
      required: true,
      manifestPath: ".buildchain/artifacts/check-manifest.json",
      summaryPath: ".buildchain/artifacts/check-summary.json",
    });

    const events = fs.readFileSync(
      path.join(workspace, ".buildchain/source-check-events.txt"),
      "utf8",
    ).trim().split("\n");
    assert.deepEqual(events, ["install:source", "check:source"]);
    assert.ok(!events.some((event) => event.startsWith("build:")));
    assert.ok(!events.some((event) => event.startsWith("verify:")));
  } finally {
    if (previousMode === undefined) delete process.env.BUILDCHAIN_CHECK_MODE;
    else process.env.BUILDCHAIN_CHECK_MODE = previousMode;
  }
});

test("reusable web-surface workflow exposes preview, cleanup, staging, and production gates", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.web-surface.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /permissions:\n  actions: read\n  contents: read/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /buildchain-contract-lock-path:/);
  assert.match(workflow, /buildchain-contract-compatibility-policy:/);
  assert.match(workflow, /buildchain-contract-drift-issue-mode:/);
  assert.match(workflow, /default: "major-compatible"/);
  assert.match(workflow, /default: "compatible-and-breaking"/);
  assert.match(workflow, /Resolve Buildchain runtime/);
  assert.match(workflow, /runtime-sha/);
  assert.match(workflow, /Validate web-surface apply inputs/);
  assert.match(workflow, /Validate apply inputs before build/);
  assert.match(workflow, /Check Buildchain contract lock/);
  assert.match(workflow, /buildchain-contract-lock\.mjs check/);
  assert.match(workflow, /Report consumer Buildchain contract drift/);
  assert.match(workflow, /contract-lock-status=/);
  assert.ok(
    workflow.indexOf("Validate web-surface apply inputs") <
      workflow.indexOf("Run caller build"),
  );
  assert.ok(
    workflow.indexOf("Check Buildchain contract lock") <
      workflow.indexOf("Run caller build"),
  );
  assert.match(workflow, /preview-aws-role-arn is required before preview-apply can build or deploy/);
  assert.match(workflow, /staging-aws-role-arn is required before staging-apply can build or deploy/);
  assert.match(workflow, /production-apply requires production-approved=true before production build or deploy/);
  assert.match(workflow, /production-aws-role-arn is required before production-apply can build or deploy/);
  assert.match(workflow, /production-release-on-main:/);
  assert.match(workflow, /production-release-label:/);
  assert.match(workflow, /production-release-head-prefix:/);
  assert.match(workflow, /production-release-branch-channel:/);
  assert.match(workflow, /production-release-pr-mode:/);
  assert.match(workflow, /production-release-pr-token:/);
  assert.match(workflow, /production-release-app-id:/);
  assert.match(workflow, /production-release-app-client-id:/);
  assert.match(workflow, /production-release-app-private-key:/);
  assert.match(workflow, /fail-on-release-pr-error:/);
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
  assert.match(workflow, /Upload preview apply diagnostics/);
  assert.match(workflow, /buildchain-web-surface-preview-diagnostics/);
  assert.match(workflow, /Apply pull request preview cleanup/);
  assert.match(workflow, /preview-cleanup-apply/);
  assert.match(workflow, /Plan main staging deploy/);
  assert.match(workflow, /github\.ref_name == 'main'/);
  assert.match(workflow, /needs\.release-intent\.outputs\.production-release-approved == 'true'/);
  assert.match(workflow, /Apply staging deploy/);
  assert.match(workflow, /needs\.plan\.outputs\.web-surface-channel == 'staging'/);
  assert.match(workflow, /staging-aws-role-arn is required when staging-apply is true/);
  assert.match(workflow, /Write staging release PR summary/);
  assert.match(workflow, /web-surface-staging-release-pr-summary\.json/);
  assert.match(workflow, /Upload staging apply diagnostics/);
  assert.match(workflow, /buildchain-web-surface-staging-diagnostics/);
  assert.match(workflow, /Upload staging release PR summary/);
  assert.match(workflow, /buildchain-web-surface-staging-release-pr-summary/);
  assert.match(workflow, /Open production release PR/);
  assert.match(workflow, /web-surface-production-release-pr\.mjs/);
  assert.match(workflow, /PRODUCTION_RELEASE_PR_MODE: \$\{\{ inputs\.production-release-pr-mode \}\}/);
  assert.match(workflow, /FAIL_ON_RELEASE_PR_ERROR: \$\{\{ inputs\.fail-on-release-pr-error \}\}/);
  assert.match(workflow, /Resolve production release token config/);
  assert.match(workflow, /Create production release app token/);
  assert.match(workflow, /actions\/create-github-app-token@v3\.1\.1/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /client-id: \$\{\{ inputs\.production-release-app-client-id \|\| inputs\.production-release-app-id \}\}/);
  assert.match(workflow, /private-key: \$\{\{ secrets\.production-release-app-private-key \}\}/);
  assert.match(workflow, /Resolve production release token source/);
  assert.match(
    workflow,
    /GITHUB_TOKEN: \$\{\{ steps\.production-release-app-token\.outputs\.token \|\| inputs\.production-release-pr-token \|\| github\.token \}\}/,
  );
  assert.match(workflow, /PRODUCTION_RELEASE_TOKEN_SOURCE: \$\{\{ steps\.production-release-token\.outputs\.token-source \}\}/);
  assert.match(workflow, /PRODUCTION_RELEASE_APP_TOKEN_STATUS: \$\{\{ steps\.production-release-token\.outputs\.app-token-status \}\}/);
  assert.match(workflow, /buildchain-web-surface-production-release-pr-handoff/);
  assert.match(workflow, /release-pr-status/);
  assert.match(workflow, /needs\.staging-apply\.result == 'success'/);
  assert.match(workflow, /needs\.release-intent\.outputs\.production-release-approved != 'true'/);
  assert.match(workflow, /Download staging release PR summary/);
  assert.match(workflow, /STAGING_RELEASE_PR_SUMMARY_PATH/);
  assert.doesNotMatch(
    workflow,
    /STAGING_APPLY_RESULT_JSON:\s*\$\{\{ needs\.staging-apply\.outputs\.staging-apply-result-json \}\}/,
  );
  assert.match(workflow, /production-release-pr-url/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /Plan gated production deploy/);
  assert.match(workflow, /web-surface-channel: \$\{\{ steps\.gate\.outputs\.web-surface-channel \}\}/);
  assert.match(workflow, /BUILDCHAIN_WEB_SURFACE_CHANNEL: \$\{\{ needs\.apply-input-gate\.outputs\.web-surface-channel \}\}/);
  assert.match(workflow, /BUILDCHAIN_PREVIEW_ALIAS: \$\{\{ needs\.apply-input-gate\.outputs\.web-surface-alias \}\}/);
  assert.match(workflow, /EVENT_NAME" = "workflow_dispatch".*web_surface_channel=staging/s);
  assert.ok(workflow.indexOf("id: gate") < workflow.indexOf("Run caller build"));
  assert.match(workflow, /Apply production deploy/);
  assert.match(workflow, /Seal web production publication capability/);
  assert.match(
    workflow,
    /name: Seal web production publication capability[\s\S]*?permissions:\n      actions: read\n      contents: read[\s\S]*?uses: \.\/\.github\/workflows\/\.publication-authority\.yml/,
  );
  assert.match(workflow, /uses: \.\/\.github\/workflows\/\.publication-authority\.yml/);
  assert.match(workflow, /publication-admission-json:/);
  assert.match(workflow, /publication-control-plane-audit-json:/);
  assert.match(workflow, /- publication-authority/);
  assert.match(workflow, /inputs\.production-apply/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.production-approved/);
  assert.match(workflow, /github\.event_name == 'push' && github\.ref_name == 'main' && inputs\.production-release-on-main/);
  assert.match(workflow, /production-aws-role-arn is required when production-apply is true/);
  assert.match(workflow, /Upload production apply diagnostics/);
  assert.match(workflow, /buildchain-web-surface-production-diagnostics/);
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

test("web-surface apply GitHub output summary omits operation logs", () => {
  const summary = compactWebSurfaceApplyResult({
    contract: "kungfu-buildchain-web-surface-deploy-apply",
    channel: "staging",
    status: "applied",
    url: "https://staging.libkungfu.dev",
    urls: { default: "https://staging.libkungfu.dev" },
    sourceSha: "abcdef1234567890abcdef1234567890abcdef12",
    artifactHash: "sha256:artifact",
    operations: [
      {
        action: "aws",
        stdout: "x".repeat(1000),
        stderr: "y".repeat(1000),
      },
    ],
    surfaceBindings: [
      {
        surface: "default",
        url: "https://staging.libkungfu.dev",
        objectPrefix: "staging/default",
      },
    ],
  });
  assert.equal(summary.channel, "staging");
  assert.equal(summary.sourceSha, "abcdef1234567890abcdef1234567890abcdef12");
  assert.equal(summary.artifactHash, "sha256:artifact");
  assert.equal(summary.operations, undefined);
  assert.equal(summary.stdout, undefined);
  assert.equal(summary.stderr, undefined);
  assert.deepEqual(summary.urls, { default: "https://staging.libkungfu.dev" });
});

test("production release PR summary can be read from artifact file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-pr-summary-"));
  const summaryPath = path.join(dir, "web-surface-staging-release-pr-summary.json");
  const fullApplyResult = {
    channel: "staging",
    status: "applied",
    urls: {
      core: "https://core.staging.libkungfu.dev",
      buildchain: "https://buildchain.staging.libkungfu.dev",
    },
    sourceSha: "abcdef1234567890abcdef1234567890abcdef12",
    artifactHash: "sha256:artifact",
    operations: [{ stdout: "large-output" }],
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(compactProductionReleasePrSummary(fullApplyResult), null, 2)}\n`);
  const summary = readStagingReleasePrSummary({
    STAGING_RELEASE_PR_SUMMARY_PATH: summaryPath,
  });
  assert.equal(summary.sourceSha, "abcdef1234567890abcdef1234567890abcdef12");
  assert.equal(summary.artifactHash, "sha256:artifact");
  assert.equal(summary.operations, undefined);
  assert.deepEqual(summary.urls, {
    core: "https://core.staging.libkungfu.dev",
    buildchain: "https://buildchain.staging.libkungfu.dev",
  });
});

test("web-surface production release PR body carries staging evidence", () => {
  const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
  const branch = releaseBranchName({
    prefix: "release/",
    channel: "production",
    sourceSha,
  });
  assert.equal(branch, "release/production-abcdef123456");
  const body = renderProductionReleasePrBody({
    stagingResult: {
      urls: {
        hub: "https://staging.libkungfu.dev",
        buildchain: "https://buildchain.staging.libkungfu.dev",
      },
      artifactHash: "sha256:artifact",
    },
    sourceSha,
    artifactHash: "sha256:artifact",
    releasePassportArtifact: "buildchain-web-surface-staging-release-passport",
    workflowRunUrl: "https://github.com/kungfu-systems/site/actions/runs/123",
    productionReleaseLabel: "buildchain-release",
    branchName: branch,
  });
  assert.match(body, /buildchain:web-surface-production-release-pr/);
  assert.match(body, /https:\/\/staging\.libkungfu\.dev/);
  assert.match(body, /https:\/\/buildchain\.staging\.libkungfu\.dev/);
  assert.match(body, /abcdef1234567890abcdef1234567890abcdef12/);
  assert.match(body, /sha256:artifact/);
  assert.match(body, /buildchain-web-surface-staging-release-passport/);
  assert.match(body, /buildchain-release/);
  assert.match(body, /release\/production-abcdef123456/);
});

test("web-surface production release PR handoff renders manual command facts", () => {
  const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
  const handoff = createProductionReleasePrHandoff({
    repository: "kungfu-systems/site-libkungfu-dev",
    sourceSha,
    stagingResult: {
      urls: { core: "https://core.staging.libkungfu.dev" },
      artifactHash: "sha256:artifact",
    },
    productionReleaseLabel: "buildchain-release",
    productionReleaseHeadPrefix: "release/",
    productionReleaseChannel: "production",
    runId: "123",
    serverUrl: "https://github.com",
  });
  assert.equal(handoff.contract, "kungfu-buildchain-web-surface-production-release-pr-handoff");
  assert.equal(handoff.branchName, "release/production-abcdef123456");
  assert.equal(handoff.title, "Release production from abcdef123456");
  assert.match(handoff.manualCommand, /gh pr create --repo kungfu-systems\/site-libkungfu-dev/);
  assert.match(handoff.manualCommand, /--body-file \.buildchain\/production-release-pr\/body\.md/);
});

test("web-surface production release PR permission-denied is a non-fatal handoff", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-pr-permission-"));
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
  const summaryPath = path.join(workspace, "staging-summary.json");
  const outputPath = path.join(workspace, "github-output.txt");
  const stepSummaryPath = path.join(workspace, "step-summary.md");
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify({
      channel: "staging",
      status: "applied",
      sourceSha,
      urls: { default: "https://staging.libkungfu.dev" },
      artifactHash: "sha256:artifact",
    })}\n`,
  );
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url).includes("/pulls?state=open")) return new Response("[]", { status: 200 });
    if (String(url).endsWith(`/git/commits/${sourceSha}`)) {
      return new Response(JSON.stringify({ tree: { sha: "tree-sha" } }), { status: 200 });
    }
    if (String(url).endsWith("/git/commits") && options.method === "POST") {
      return new Response(JSON.stringify({ sha: "release-intent-sha" }), { status: 201 });
    }
    if (String(url).endsWith("/git/refs") && options.method === "POST") {
      return new Response(JSON.stringify({ ref: "refs/heads/release/production-abcdef123456" }), { status: 201 });
    }
    if (String(url).endsWith("/pulls") && options.method === "POST") {
      return new Response(
        JSON.stringify({ message: "GitHub Actions is not permitted to create or approve pull requests." }),
        { status: 403 },
      );
    }
    throw new Error(`unexpected fetch: ${options.method || "GET"} ${url}`);
  };
  try {
    process.chdir(workspace);
    const result = await webSurfaceProductionReleasePrCli({
      GITHUB_TOKEN: "token",
      GITHUB_REPOSITORY: "kungfu-systems/site-libkungfu-dev",
      GITHUB_SHA: sourceSha,
      GITHUB_RUN_ID: "123",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_API_URL: "https://api.github.com",
      STAGING_RELEASE_PR_SUMMARY_PATH: summaryPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: stepSummaryPath,
      PRODUCTION_RELEASE_PR_MODE: "auto",
      FAIL_ON_RELEASE_PR_ERROR: "false",
      PRODUCTION_RELEASE_PR_SUMMARY_PATH: ".buildchain/production-release-pr/handoff.json",
      PRODUCTION_RELEASE_PR_BODY_PATH: ".buildchain/production-release-pr/body.md",
    });
    assert.equal(result.status, "permission-denied");
    assert.match(fs.readFileSync(outputPath, "utf8"), /release-pr-status=permission-denied/);
    assert.match(fs.readFileSync(outputPath, "utf8"), /production-release-token-source=github-token/);
    assert.match(fs.readFileSync(stepSummaryPath, "utf8"), /Manual PR creation command/);
    const handoff = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/production-release-pr/handoff.json"), "utf8"));
    assert.equal(handoff.status, "permission-denied");
    assert.equal(handoff.error.status, 403);
    assert.equal(handoff.tokenSource, "github-token");
    assert.ok(calls.some((call) => call.method === "POST" && call.url.endsWith("/pulls")));
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = previousFetch;
  }
});

test("web-surface production release PR reports unavailable app token before fallback github token", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-pr-app-token-unavailable-"));
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
  const summaryPath = path.join(workspace, "staging-summary.json");
  const outputPath = path.join(workspace, "github-output.txt");
  const stepSummaryPath = path.join(workspace, "step-summary.md");
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify({
      channel: "staging",
      status: "applied",
      sourceSha,
      urls: { default: "https://staging.libkungfu.dev" },
      artifactHash: "sha256:artifact",
    })}\n`,
  );
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not be called when app token is unavailable");
  };
  try {
    process.chdir(workspace);
    const result = await webSurfaceProductionReleasePrCli({
      GITHUB_TOKEN: "github-token",
      GITHUB_REPOSITORY: "kungfu-systems/site-libkungfu-dev",
      GITHUB_SHA: sourceSha,
      GITHUB_RUN_ID: "123",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_API_URL: "https://api.github.com",
      STAGING_RELEASE_PR_SUMMARY_PATH: summaryPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: stepSummaryPath,
      PRODUCTION_RELEASE_PR_MODE: "auto",
      FAIL_ON_RELEASE_PR_ERROR: "false",
      PRODUCTION_RELEASE_TOKEN_SOURCE: "github-token",
      PRODUCTION_RELEASE_APP_TOKEN_STATUS: "missing-private-key",
      PRODUCTION_RELEASE_APP_TOKEN_UNAVAILABLE: "true",
      PRODUCTION_RELEASE_APP_CLIENT_ID_CONFIGURED: "true",
      PRODUCTION_RELEASE_APP_PRIVATE_KEY_CONFIGURED: "false",
      PRODUCTION_RELEASE_PR_TOKEN_CONFIGURED: "false",
      PRODUCTION_RELEASE_PR_SUMMARY_PATH: ".buildchain/production-release-pr/handoff.json",
      PRODUCTION_RELEASE_PR_BODY_PATH: ".buildchain/production-release-pr/body.md",
    });
    assert.equal(result.status, "app-token-unavailable");
    assert.equal(called, false);
    assert.match(fs.readFileSync(outputPath, "utf8"), /release-pr-status=app-token-unavailable/);
    assert.match(fs.readFileSync(outputPath, "utf8"), /production-release-app-token-status=missing-private-key/);
    assert.match(fs.readFileSync(stepSummaryPath, "utf8"), /app token status: `missing-private-key`/);
    const handoff = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/production-release-pr/handoff.json"), "utf8"));
    assert.equal(handoff.status, "app-token-unavailable");
    assert.equal(handoff.appConfig.clientIdConfigured, true);
    assert.equal(handoff.appConfig.privateKeyConfigured, false);
    assert.match(handoff.manualCommand, /gh pr create/);
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = previousFetch;
  }
});

test("web-surface production release PR summary-only mode does not call GitHub PR API", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-pr-summary-only-"));
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
  const summaryPath = path.join(workspace, "staging-summary.json");
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify({
      channel: "staging",
      status: "applied",
      sourceSha,
      urls: { default: "https://staging.libkungfu.dev" },
      artifactHash: "sha256:artifact",
    })}\n`,
  );
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not be called");
  };
  try {
    process.chdir(workspace);
    const result = await webSurfaceProductionReleasePrCli({
      GITHUB_TOKEN: "",
      GITHUB_REPOSITORY: "kungfu-systems/site-libkungfu-dev",
      GITHUB_SHA: sourceSha,
      STAGING_RELEASE_PR_SUMMARY_PATH: summaryPath,
      PRODUCTION_RELEASE_PR_MODE: "summary-only",
      PRODUCTION_RELEASE_PR_SUMMARY_PATH: ".buildchain/production-release-pr/handoff.json",
      PRODUCTION_RELEASE_PR_BODY_PATH: ".buildchain/production-release-pr/body.md",
    });
    assert.equal(result.status, "summary-only");
    assert.equal(called, false);
    assert.equal(fs.existsSync(path.join(workspace, ".buildchain/production-release-pr/handoff.json")), true);
    assert.equal(fs.existsSync(path.join(workspace, ".buildchain/production-release-pr/body.md")), true);
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = previousFetch;
  }
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
  assert.match(workflow, /upload-release is retired from the evidence-only Binary Distribution workflow/);
  assert.match(workflow, /needs: preflight/);
  assert.match(workflow, /needs: \[preflight, binary\]/);
});

test("binary evidence and product publication are isolated by the sealed asset workflow", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/binary-distribution.yml"),
    "utf8",
  );
  const publication = fs.readFileSync(
    path.join(root, ".github/workflows/.binary-release-assets.yml"),
    "utf8",
  );
  assert.match(workflow, /Fetch durable release-state passport/);
  assert.match(workflow, /refs\/heads\/\$\{ref\}:refs\/remotes\/origin\/\$\{ref\}/);
  assert.match(workflow, /authoritative-release-state-passport\.json/);
  assert.match(workflow, /authoritative-release-state-impact\.json/);
  assert.match(workflow, /durable release-state passport KFD base: ok/);
  assert.match(workflow, /durable release-state impact: ok/);
  assert.match(workflow, /kfd-1/);
  assert.match(workflow, /kfd-2/);
  assert.match(workflow, /kfd-3/);
  assert.doesNotMatch(
    workflow.slice(
      workflow.indexOf("Fetch durable release-state passport"),
      workflow.indexOf("Collect release passport"),
    ),
    /verify release-passport/,
  );
  assert.match(workflow, /--base-passport-json \.buildchain\/release-passport\/authoritative-release-state-passport\.json/);
  assert.match(workflow, /--impact-json \.buildchain\/release-evidence\/authoritative-release-state-impact\.json/);
  assert.match(workflow, /--require-base-kfd/);
  assert.doesNotMatch(workflow, /scripts\/ensure-github-release\.mjs/);
  assert.doesNotMatch(workflow, /gh release upload/);
  assert.match(publication, /uses: \.\/\.github\/workflows\/\.publication-authority\.yml/);
  assert.match(publication, /needs: publication-authority/);
  assert.match(publication, /environment: buildchain-release-assets/);
  assert.match(publication, /scripts\/ensure-github-release\.mjs/);
  assert.match(publication, /--repository "\$\{\{ github\.repository \}\}"/);
  assert.match(publication, /--tag "\$RELEASE_TAG"/);
  assert.match(publication, /gh release upload "\$RELEASE_TAG"/);
  assert.match(publication, /capability\.artifactDigest !== actualArtifact/);
  assert.doesNotMatch(workflow, /gh release create/);
});

test("runtime selection accepts official channels and gates train or SHA overrides", () => {
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
  assert.deepEqual(
    resolveRuntimeSelection({ requestedRef: "", workflowRef: "kungfu-systems/buildchain/.github/workflows/.build.yml@refs/tags/v2-alpha" }),
    {
      requestedRef: "",
      runtimeRef: "v2-alpha",
      runtimeFullRef: "v2-alpha",
      runtimeClass: "alpha",
      runtimeOverride: false,
      workflowShellRef: "v2-alpha",
      rollbackRef: "v2-alpha",
      trustDecision: "stable-default",
    },
  );
  assert.equal(
    resolveRuntimeSelection({ requestedRef: "", workflowRef: "kungfu-systems/libnode/.github/workflows/build.yml@main" }).runtimeRef,
    "v2",
  );
  assert.deepEqual(
    resolveRuntimeSelection({
      requestedRef: "v2-alpha",
      workflowRef: "kungfu-systems/libnode/.github/workflows/build.yml@main",
    }),
    {
      requestedRef: "v2-alpha",
      runtimeRef: "v2-alpha",
      runtimeFullRef: "v2-alpha",
      runtimeClass: "alpha",
      runtimeOverride: false,
      workflowShellRef: "v2",
      rollbackRef: "v2",
      trustDecision: "official-channel",
    },
  );
  assert.deepEqual(
    validateRuntimeOverrideTrust({
      requestedRef: "v2-alpha",
      eventName: "pull_request",
      actorPermission: "none",
    }),
    { ok: true, decision: "official-channel" },
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

test("runtime-aware workflows distinguish official channels from overrides", () => {
  const workflowFiles = [
    ".github/workflows/.build.yml",
    ".github/workflows/.release-verify.yml",
    ".github/workflows/.web-surface.yml",
    ".github/workflows/paper-release.yml",
    ".github/workflows/publication-artifact.yml",
  ];
  for (const workflowFile of workflowFiles) {
    const workflow = fs.readFileSync(path.join(root, workflowFile), "utf8");
    assert.match(workflow, /BUILDCHAIN_WORKFLOW_REF: \$\{\{ job\.workflow_ref \}\}/);
    assert.match(workflow, /process\.env\.BUILDCHAIN_WORKFLOW_REF \|\| process\.env\.GITHUB_WORKFLOW_REF/);
    assert.match(workflow, /const officialChannelRef = \/\^v\\d\+/);
    assert.match(workflow, /const officialChannel = officialChannelRef\.test\(requested\)/);
    assert.match(workflow, /requested !== "" && !officialChannel/);
    assert.match(workflow, /\? "official-channel"/);
    assert.match(workflow, /buildchain-ref override is only allowed for trusted workflow_dispatch runs/);
  }
});

test("runtime-aware workflows pin same-repository pull request merge refs", () => {
  const workflowFiles = [
    ".github/workflows/.build.yml",
    ".github/workflows/.gate-profile.yml",
    ".github/workflows/.release-verify.yml",
    ".github/workflows/.web-surface.yml",
    ".github/workflows/paper-release.yml",
    ".github/workflows/publication-artifact.yml",
  ];
  for (const workflowFile of workflowFiles) {
    const workflow = fs.readFileSync(path.join(root, workflowFile), "utf8");
    assert.match(workflow, /const sameRepositoryWorkflow = workflowRef\.startsWith/);
    assert.match(workflow, /const pullRequestMergeRef = \/\^refs\\\/pull\\\/\\d\+\\\/merge\$\//);
    assert.match(workflow, /sameRepositoryWorkflow && pullRequestMergeRef\.test\(ref\)/);
    assert.match(workflow, /const workflowSha = String\(context\.sha \|\| ""\)/);
    assert.match(workflow, /current workflow SHA is invalid for Buildchain pull request merge ref/);
  }
});

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
  assert.match(action, /planned-publication-version:/);
  assert.match(implementation, /expectedPublicationVersion/);
  assert.match(implementation, /planned-publication-version/);
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
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
    "utf8",
  );

  assert.match(action, /branch-protection-bypass-apps:/);
  assert.match(action, /branch-protection-bypass-users:/);
  assert.match(action, /branch-protection-bypass-teams:/);
  assert.match(action, /generated-ref-update-token:/);
  assert.match(implementation, /branchProtectionBypassApps/);
  assert.match(implementation, /generatedRefUpdateToken/);
  assert.match(implementation, /refUpdateOctokit/);
  assert.match(wrapper, /branch-protection-bypass-apps:/);
  assert.match(wrapper, /default: "github-actions"/);
  assert.match(wrapper, /branch-protection-bypass-users:/);
  assert.match(wrapper, /branch-protection-bypass-teams:/);
  assert.match(wrapper, /branch-protection-bypass-apps: \$\{\{ inputs\.branch-protection-bypass-apps \}\}/);
  assert.match(wrapper, /checks: write/);
  assert.match(wrapper, /generated-status-check-token: \$\{\{ github\.token \}\}/);
  assert.match(wrapper, /BUILDCHAIN_PROMOTION_TOKEN:\n\s+description:/);
  assert.match(
    wrapper,
    /generated-ref-update-token: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \|\| github\.token \}\}/,
  );

  const selfPromotion = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-ref-promotion.yml"),
    "utf8",
  );
  assert.match(selfPromotion, /checks: write/);
  assert.match(selfPromotion, /BUILDCHAIN_PROMOTION_BYPASS_APPS/);
  assert.match(selfPromotion, /BUILDCHAIN_PROMOTION_BYPASS_USERS/);
  assert.match(selfPromotion, /BUILDCHAIN_PROMOTION_BYPASS_TEAMS/);
});

test("Buildchain stable promotion gates publication after RC resolution", () => {
  const wrapper = fs.readFileSync(
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
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
  assert.match(wrapper, /Buildchain stable candidate must declare an exact alpha version/);
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
  assert.match(workflow, /gate-profile-aggregate-json:/);
  assert.match(workflow, /BUILDCHAIN_GATE_PROFILE_AGGREGATE_JSON/);
  assert.match(workflow, /<artifact-name>-release-candidate-|release-candidate-/);
});

test("reusable build exposes runner-local tools before lifecycle execution", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.build.yml"),
    "utf8",
  );

  assert.match(workflow, /name: Expose Windows runner user toolchain/);
  assert.match(workflow, /Join-Path \$HOME "\.local\\bin"/);
  assert.match(workflow, /name: Expose POSIX runner user toolchain/);
  assert.match(workflow, /\$\{HOME\}\/\.local\/bin/);
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
  assert.match(workflow, /name: Expose POSIX runner user toolchain/);
  assert.match(workflow, /\$\{HOME\}\/\.local\/bin/);
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
  assert.match(
    workflow,
    /artifact-transfer-mode: \$\{\{ github\.event\.inputs\['artifact-transfer-mode'\] \|\| 'github-artifacts' \}\}/,
  );
  assert.match(workflow, /checkout-cache-mode: auto/);
  assert.match(workflow, /checkout-cache-fallback: github/);
  assert.doesNotMatch(workflow, /run: node scripts\/artifact-relay-s3\.mjs/);
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
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
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
  assert.match(action, /release-passport-kfd-1-witness-jsons:/);
  assert.match(action, /release-passport-kfd-2-claim-jsons:/);
  assert.match(action, /release-passport-kfd-3-prebuild-witness-jsons:/);
  assert.match(action, /release-passport-kfd-3-artifact-witness-jsons:/);
  assert.match(action, /release-passport-kfd-3-artifact-verify-command:/);
  assert.match(action, /release-passport-buildchain-self-kfd:/);
  assert.match(implementation, /promoteOnlyReleaseCandidate/);
  assert.match(implementation, /reconciliationWorkspace/);
  assert.match(implementation, /releasePassportKfd1WitnessJsons/);
  assert.match(implementation, /releasePassportKfd2ClaimJsons/);
  assert.match(implementation, /releasePassportKfd3PrebuildWitnessJsons/);
  assert.match(implementation, /releasePassportKfd3ArtifactWitnessJsons/);
  assert.match(implementation, /releasePassportKfd3ArtifactVerifyCommand/);
  assert.match(implementation, /releasePassportBuildchainSelfKfd/);
  assert.match(docs, /promote-only-release-candidate: "true"/);
  assert.match(docs, /release-passport-kfd-1-witness-jsons/);
  assert.match(docs, /release-passport-kfd-2-claim-jsons/);
  assert.match(docs, /release-passport-kfd-3-prebuild-witness-jsons/);
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

  assert.match(workflow, /actions: read/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/release-candidate-promote\.yml/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /startsWith\(github\.event\.workflow_run\.head_branch, 'alpha\/'\)/);
  assert.match(workflow, /startsWith\(github\.event\.workflow_run\.head_branch, 'release\/'\)/);
  assert.match(workflow, /!startsWith\(github\.event\.workflow_run\.display_title, 'chore\(release\): prepare v'\)/);
  assert.match(workflow, /!startsWith\(github\.event\.workflow_run\.display_title, 'chore\(release\): release v'\)/);
  assert.match(workflow, /buildchain-ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| inputs\.sha \|\| github\.sha \}\}/);
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
  assert.match(bootstrap, /BUILDCHAIN_PROMOTION_BYPASS_APPS: \$\{\{ vars\.BUILDCHAIN_PROMOTION_BYPASS_APPS \}\}/);
  assert.match(bootstrap, /BUILDCHAIN_PROMOTION_BYPASS_USERS: \$\{\{ vars\.BUILDCHAIN_PROMOTION_BYPASS_USERS \}\}/);
  assert.match(bootstrap, /BUILDCHAIN_PROMOTION_BYPASS_TEAMS: \$\{\{ vars\.BUILDCHAIN_PROMOTION_BYPASS_TEAMS \}\}/);
  assert.match(bootstrap, /Release line bootstrap requires a declared promotion bypass app, user, or team/);
  assert.match(bootstrap, /bypass_pull_request_allowances:\s*\{\s*apps: \$bypass_apps,\s*users: \$bypass_users,\s*teams: \$bypass_teams\s*\}/);
  assert.match(workflow, /publish-required-artifacts-json: "\[\]"/);
  assert.match(workflow, /release-passport-impact-json: \.buildchain\/release-impact\.json/);
  assert.match(workflow, /publication-auto-admission: \$\{\{ github\.event_name == 'workflow_run' \}\}/);
  assert.match(workflow, /publication-auto-no-gate: \$\{\{ github\.event_name == 'workflow_run' \}\}/);
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

  assert.match(action, /github-release:/);
  assert.match(action, /github-release-artifact-paths:/);
  assert.match(action, /github-release-title:/);
  assert.match(action, /github-release-notes:/);
  assert.match(action, /public-release-tag:/);
  assert.match(action, /github-release-url:/);
  assert.match(action, /github-release-action:/);
  assert.match(source, /ensureGitHubRelease/);
  assert.match(source, /publishGitHubReleaseEvidence/);
  assert.match(source, /collectGitHubReleaseEvidenceAssets/);
  assert.match(source, /duplicate asset basename/);
  assert.match(source, /uploadReleaseAsset/);
  assert.match(source, /transaction-state.*complete/s);
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

test("Buildchain self-dogfoods the current major alpha without replacing exact-SHA promotion", () => {
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
  assert.match(workflow, /group: buildchain-release-promotion-\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /build\.yml@v2-alpha/);
  assert.match(workflow, /buildchain-channel: auto/);
  assert.match(workflow, /buildchain-channel: stable/);
  assert.match(workflow, /ALPHA_RUNTIME_SHA: \$\{\{ needs\.alpha-consumer\.outputs\.buildchain-runtime-sha \}\}/);
  assert.match(workflow, /STABLE_RUNTIME_SHA: \$\{\{ needs\.stable-consumer\.outputs\.buildchain-runtime-sha \}\}/);
  assert.match(workflow, /ref: `tags\/\$\{tag\}`/);
  assert.match(workflow, /kungfu-buildchain-alpha-self-dogfood/);
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
  assert.doesNotMatch(workflow, /buildchain-ref:/);
  assert.doesNotMatch(workflow, /\.build\.yml@v2\n/);
  assert.doesNotMatch(workflow, /buildchain-contract-lock-path:/);

  const alphaLock = JSON.parse(
    fs.readFileSync(path.join(root, ".buildchain/alpha-contract-lock.json"), "utf8"),
  );
  const currentContract = JSON.parse(
    fs.readFileSync(path.join(root, "dist/site/buildchain-contract.json"), "utf8"),
  );
  assert.equal(alphaLock.buildchain.ref, "v2-alpha");
  assert.equal(alphaLock.buildchain.resolvedSha, "d7b9453665a60392e9082444dcc8e023cafc000c");
  assert.equal(alphaLock.buildchain.compatibilityPolicy, "major-compatible");
  const alphaEvaluation = evaluateBuildchainContractLock({
    lock: alphaLock,
    current: currentContract,
    runtimeRef: "v2-alpha",
    runtimeSha: "current-development-contract",
    runtimeClass: "alpha",
  });
  assert.equal(alphaEvaluation.compatible, true);

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

  assert.match(promotion, /buildchain-ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| inputs\.sha \|\| github\.sha \}\}/);
  assert.doesNotMatch(promotion, /buildchain-ref: (?:v\d+-alpha|\$\{\{[^\n]*v\d+-alpha)/);
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
    fs.writeFileSync(path.join(workspace, ".buildchain/diagnostics/source-checkout.json"), `${JSON.stringify({
      schemaVersion: 1,
      contract: "kungfu-buildchain-locked-source-checkout-cache",
      policy: { mode: "auto", fallback: "github" },
      cache: { transport: "mirror-url", hit: true, fallbackUsed: false, fallbackReason: "" },
      verification: { head: "2".repeat(40), tree: "3".repeat(40), headOk: true, treeOk: true },
      durationMs: 123,
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
    const diagnosticsManifest = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/artifacts/linux-x64/diagnostics-manifest.json"),
        "utf8",
      ),
    );
    assert.equal(diagnosticsManifest.contract, BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT);
    assert.equal(diagnosticsManifest.artifactName, "libnode-shaped-linux-x64-abc123");
    assert.equal(diagnosticsManifest.platformId, "linux-x64");
    assert.equal(diagnosticsManifest.fileCount, 5);
    assert.deepEqual(
      diagnosticsManifest.files.map((file) => file.kind),
      ["diagnostics", "events", "process-summary", "process-samples", "source-checkout"],
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
  } finally {
    process.env = originalEnv;
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
