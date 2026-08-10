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

test("every workflow v2 token is explicitly governed and no ungoverned runtime default remains", () => {
  const inventory = JSON.parse(
    fs.readFileSync(path.join(root, "contracts/buildchain-v2-residuals-v1.json"), "utf8"),
  );
  assert.equal(inventory.contract, "buildchain.v2-residual-inventory/v1");
  assert.equal(inventory.policy.runtimeDefault, "v3");
  assert.equal(inventory.policy.dogfoodRuntimeDefault, "v3-alpha");
  assert.equal(inventory.policy.unclassifiedV2TokensAllowed, false);

  const allowedClassifications = new Set([
    "legacy-compatibility-action",
    "legacy-compatibility-ref",
    "retired-input-tombstone",
    "retired-path-tombstone",
    "third-party-action-version",
  ]);
  for (const entry of inventory.entries) {
    assert.ok(entry.path.startsWith(".github/workflows/"), `${entry.path} must be a workflow`);
    assert.ok(entry.token.toLowerCase().includes("v2"), `${entry.path} token must identify v2`);
    assert.ok(Number.isInteger(entry.expectedOccurrences) && entry.expectedOccurrences > 0);
    assert.ok(allowedClassifications.has(entry.classification), `${entry.path} classification must be governed`);
    assert.ok(entry.callerStatus, `${entry.path} must declare caller status`);
    assert.ok(entry.owner, `${entry.path} must declare an owner`);
    assert.ok(entry.sunsetCondition, `${entry.path} must declare a sunset condition`);

    const source = fs.readFileSync(path.join(root, entry.path), "utf8");
    assert.equal(
      source.split(entry.token).length - 1,
      entry.expectedOccurrences,
      `${entry.path} residual count drifted for ${entry.token}`,
    );
  }

  const workflowDir = path.join(root, ".github/workflows");
  for (const name of fs.readdirSync(workflowDir).filter((entry) => /\.ya?ml$/.test(entry))) {
    const workflowPath = `.github/workflows/${name}`;
    const source = fs.readFileSync(path.join(workflowDir, name), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (!line.toLowerCase().includes("v2")) continue;
      const matches = inventory.entries.filter(
        (entry) => entry.path === workflowPath && line.includes(entry.token),
      );
      assert.equal(
        matches.length,
        1,
        `${workflowPath}:${index + 1} has an unclassified or ambiguous v2 token: ${line.trim()}`,
      );
    }
  }
});

test("public reusable controllers expose source-bound plan and always-aggregated receipt outputs", () => {
  const workflows = [
    ".github/workflows/check.yml",
    ".github/workflows/.build.yml",
    ".github/workflows/build.yml",
    ".github/workflows/.gate-profile.yml",
    ".github/workflows/.web-surface.yml",
    ".github/workflows/publication-artifact.yml",
    ".github/workflows/paper-release.yml",
    ".github/workflows/.release-candidate-promote.yml",
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
  assert.match(
    channelRouter,
    /  summarize:\n    name: Summarize build contract\n    needs:\n      - build\n      - controller-receipt/,
    "the public router must emit a stable top-level aggregate independent of nested workflow job names",
  );
  assert.match(channelRouter, /Enforce public channel router aggregate/);

  const governanceReconciliation = fs.readFileSync(
    path.join(root, ".github/workflows/release-governance-reconcile.yml"),
    "utf8",
  );
  assert.match(governanceReconciliation, /workflow_call:/);
  assert.match(governanceReconciliation, /workflow_dispatch:/);
  assert.match(governanceReconciliation, /--candidate-sha "\$\{BUILDCHAIN_CANDIDATE_SHA\}"/);
  assert.match(governanceReconciliation, /args\+\=\(--apply\)/);
  assert.match(governanceReconciliation, /persist-credentials: false/);

  const libnodeConsumer = fs.readFileSync(
    path.join(root, "fixtures/libnode-shaped/.github/workflows/build.yml"),
    "utf8",
  );
  assert.match(
    libnodeConsumer,
    /  build:\n    uses: kungfu-systems\/buildchain\/\.github\/workflows\/build\.yml@v3/,
  );

  const reusableBuild = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  assert.match(reusableBuild, /Checkout build controller workflow shell/);
  assert.match(reusableBuild, /BUILDCHAIN_CONTROLLER_RUNTIME_REF: \$\{\{ needs\.trust-gate\.outputs\.buildchain-runtime-ref \}\}/);
  assert.match(reusableBuild, /BUILDCHAIN_CONTROLLER_RUNTIME_SHA: \$\{\{ needs\.trust-gate\.outputs\.buildchain-runtime-sha \}\}/);
  assert.match(reusableBuild, /BUILDCHAIN_CONTROLLER_CONTRACT_DIGEST: \$\{\{ needs\.trust-gate\.outputs\.buildchain-contract-digest \}\}/);
  assert.doesNotMatch(reusableBuild, /BUILDCHAIN_CONTROLLER_RUNTIME_(?:REF|SHA): \$\{\{ needs\.trust-gate\.outputs\.buildchain-workflow-shell-/);
  assert.match(reusableBuild, /BUILDCHAIN_CONTROLLER_REGISTRY: \.buildchain\/controller-runtime\/dist\/site\/controller-registry\.json/);

  const paperRelease = fs.readFileSync(path.join(root, ".github/workflows/paper-release.yml"), "utf8");
  const promotion = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
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
  const router = fs.readFileSync(
    path.join(root, ".github/workflows/build.yml"),
    "utf8",
  );
  const summarizeJob = workflow.slice(
    workflow.indexOf("  summarize:"),
    workflow.indexOf("\n  controller-receipt:", workflow.indexOf("  summarize:")),
  );
  const artifactDownloads =
    workflow.match(/uses: actions\/download-artifact@v7\.0\.0/g) || [];
  const authenticatedArtifactDownloads =
    workflow.match(
      /uses: actions\/download-artifact@v7\.0\.0\n\s+with:\n\s+github-token: \$\{\{ (?:github\.token|secrets\.BUILDCHAIN_PROMOTION_TOKEN) \}\}/g,
    ) || [];
  assert.match(workflow, /workflow_call:/);
  assert.equal(
    authenticatedArtifactDownloads.length,
    artifactDownloads.length,
    "every reusable-build artifact download must use the REST-backed token path so failed-job reruns can consume prior-attempt evidence",
  );
  assert.match(
    workflow,
    /control-runner-json:\n\s+description: "JSON runner-label array for trusted control-plane jobs"[\s\S]*?default: '\["ubuntu-24\.04"\]'/,
  );
  assert.equal(
    (workflow.match(/runs-on: \$\{\{ fromJSON\(inputs\.control-runner-json\) \}\}/g) || []).length,
    10,
  );
  assert.match(
    workflow,
    /fail-fast:\n\s+description: "Cancel sibling platform lanes[\s\S]*?default: false[\s\S]*?type: boolean/,
  );
  assert.equal(
    (
      workflow.match(
        /strategy:\n\s+fail-fast: \$\{\{ inputs\.fail-fast \}\}/g,
      ) || []
    ).length,
    4,
  );
  assert.match(workflow, /kfd-agent-hub:\n\s+description: "Agent Hub conformance mode: off or auto/);
  assert.equal((workflow.match(/name: Run KFD Agent Hub conformance/g) || []).length, 2);
  assert.equal((workflow.match(/name: Upload KFD Agent Hub evidence/g) || []).length, 2);
  assert.match(workflow, /buildchain\.mjs kfd hub test/);
  assert.match(workflow, /artifact-name \}\}-kfd-agent-hub-\$\{\{ matrix\.platform\.id \}\}/);
  assert.match(
    workflow,
    /name: Resolve source-bound application identity[\s\S]*?loadCredentialInput[\s\S]*?sourceTreeSha: process\.env\.BUILDCHAIN_SOURCE_TREE_SHA/,
    "the credential island must derive product identity from the exact source-bound sealed manifest",
  );
  assert.match(
    workflow,
    /expected-bundle-id: \$\{\{ steps\.credential-identity\.outputs\.bundle-id \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /BUILDCHAIN_MACOS_EXPECTED_BUNDLE_ID/,
    "consumer repositories must not configure product bundle identity in the signing environment",
  );
  assert.match(workflow, /name: Validate consumer package manager contract/);
  assert.match(
    workflow,
    /validator=\.buildchain\/runtime\/scripts\/validate-package-manager-contract\.mjs/,
  );
  assert.match(
    workflow,
    /validator=\.buildchain\/workflow-shell\/scripts\/validate-package-manager-contract\.mjs/,
    "new workflow shells must retain package-manager validation when the selected stable runtime predates the validator",
  );
  assert.match(workflow, /node "\$\{validator\}"/);
  assert.match(
    workflow,
    /BUILDCHAIN_PACKAGE_MANAGER_CWD: \.buildchain\/consumer\n/,
    "consumer package-manager detection must use the repository root even when builds use a nested working directory",
  );
  assert.ok(
    workflow.indexOf("name: Validate consumer package manager contract") <
      workflow.indexOf("  build-native:"),
    "consumer package-manager incompatibility must fail before native release-candidate jobs",
  );
  assert.match(workflow, /  anchored-release-preflight:/);
  assert.match(workflow, /scripts\/anchored-version-material\.mjs/);
  assert.match(
    workflow,
    /verifier=\.buildchain\/runtime\/scripts\/anchored-version-material\.mjs/,
  );
  assert.match(
    workflow,
    /verifier=\.buildchain\/workflow-shell\/scripts\/anchored-version-material\.mjs/,
    "new workflow shells must retain the additive anchored preflight when the selected stable runtime predates its verifier",
  );
  assert.match(
    workflow,
    /install --dir \.buildchain\/workflow-shell --prod --frozen-lockfile --ignore-scripts/,
  );
  assert.match(workflow, /node "\$\{\{ steps\.anchored-verifier\.outputs\.path \}\}"/);
  assert.match(
    summarizeJob,
    /name: Checkout Buildchain workflow shell for aggregate compatibility[\s\S]*?ref: \$\{\{ needs\.trust-gate\.outputs\.buildchain-workflow-shell-sha \}\}[\s\S]*?path: \.buildchain\/workflow-shell/,
  );
  assert.match(
    summarizeJob,
    /binder=\.buildchain\/runtime\/scripts\/resolve-artifact-coordinates\.mjs/,
  );
  assert.match(
    summarizeJob,
    /binder=\.buildchain\/workflow-shell\/scripts\/resolve-artifact-coordinates\.mjs/,
    "new workflow shells must retain producer artifact coordinates when the selected stable runtime predates the binder",
  );
  assert.match(
    summarizeJob,
    /node "\$\{\{ steps\.artifact-coordinate-binder\.outputs\.path \}\}"/,
  );
  assert.match(workflow, /kind":"anchored-version-material"/);
  assert.match(workflow, /target_ref="release\/\$\{BUILDCHAIN_TARGET_LINE\}"/);
  assert.ok(
    workflow.indexOf("  anchored-release-preflight:") <
      workflow.indexOf("  build-native:"),
    "anchored derived version material must be verified before heavy native builds",
  );
  assert.match(workflow, /runner-preset:/);
  assert.match(workflow, /platforms-json:/);
  assert.match(workflow, /self-hosted-offline-fallback:/);
  assert.match(
    workflow,
    /name: Route offline self-hosted lanes[\s\S]*?BUILDCHAIN_RUNNER_INVENTORY_TOKEN: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \}\}/,
  );
  assert.match(
    workflow,
    /name: Checkout trusted runner-routing shell[\s\S]*?buildchain-workflow-shell-sha/,
  );
  assert.match(workflow, /runner-routing-json:/);
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
    7,
  );
  assert.equal(
    (workflow.match(/pnpm@11\.7\.0 install --dir \.buildchain\/runtime --prod --frozen-lockfile --ignore-scripts/g) || []).length,
    7,
  );
  assert.match(workflow, /install-command:/);
  assert.match(workflow, /build-command:/);
  assert.match(workflow, /verify-command:/);
  assert.match(workflow, /artifact-name:/);
  assert.match(workflow, /artifact-name-template:/);
  assert.match(workflow, /expected-artifacts-json:/);
  assert.equal((workflow.match(/Seal declared artifact signing requests/g) || []).length, 2);
  assert.equal((workflow.match(/Publish Buildchain-owned artifact signing request/g) || []).length, 2);
  assert.equal((workflow.match(/Seal detached signing control request/g) || []).length, 2);
  assert.equal((workflow.match(/Publish detached signing control request/g) || []).length, 2);
  assert.equal((workflow.match(/Dispatch and await exact Buildchain signing authority/g) || []).length, 1);
  assert.equal((workflow.match(/Verify and import final signed bytes on GitHub-hosted infrastructure/g) || []).length, 1);
  assert.doesNotMatch(workflow, /Download immutable signed result\n/);
  assert.equal((workflow.match(/Publish signing finalization delegation/g) || []).length, 1);
  assert.match(workflow, /artifact-signing-control:[\s\S]*?runs-on: ubuntu-24\.04/);
  assert.match(workflow, /artifact-signing-control:[\s\S]*?needs:[\s\S]*?- build-native[\s\S]*?- build-linux-container/);
  assert.match(workflow, /finalize-artifact-signing:[\s\S]*?runs-on: ubuntu-24\.04/);
  assert.match(workflow, /needs\.artifact-signing-control\.result == 'success'/);
  assert.match(workflow, /needs\.finalize-artifact-signing\.result == 'success'/);
  assert.equal(
    (
      workflow.match(
        /if \[ ! -f "\$\{signing_sealer\}" \]; then/g,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /if: \$\{\{ steps\.signing-requests\.outputs\.request-count != '0' \}\}/g,
      ) || []
    ).length,
    4,
  );
  assert.equal(
    (
      workflow.match(
        /Artifact signing request sealing is unavailable in the resolved legacy runtime/g,
      ) || []
    ).length,
    2,
  );
  const firstBuild = workflow.indexOf("      - name: Run build lifecycle");
  const firstSeal = workflow.indexOf("      - name: Seal declared artifact signing requests");
  const firstVerify = workflow.indexOf("      - name: Run verify lifecycle");
  const signingControl = workflow.indexOf("  artifact-signing-control:");
  assert.ok(firstBuild < firstSeal && firstSeal < firstVerify, "unsigned requests must be sealed between build and verify");
  assert.ok(firstVerify < signingControl, "the detached controller must be scheduled after the caller build jobs");
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf("  build-native:"), signingControl),
    /Dispatch and await exact Buildchain signing authority/u,
  );
  assert.match(workflow, /signing-request-\$\{\{ matrix\.platform\.id \}\}-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/);
  assert.match(workflow, /process-summary-path:/);
  assert.match(workflow, /sample-process-tree:/);
  assert.match(workflow, /process-sample-interval-ms:/);
  assert.match(workflow, /requested-parallelism:/);
  assert.match(workflow, /artifact-transfer-mode:/);
  assert.match(workflow, /artifact-signing-request-upload-no-proxy:/);
  assert.equal((workflow.match(/vars\.BUILDCHAIN_ARTIFACT_SIGNING_REQUEST_UPLOAD_NO_PROXY/g) || []).length, 2);
  assert.equal((workflow.match(/Resolve artifact signing request upload route/g) || []).length, 2);
  assert.equal(
    (workflow.match(/NO_PROXY: \$\{\{ steps\.signing-request-upload-route\.outputs\.no-proxy \}\}/g) || []).length,
    2,
  );
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
  assert.match(workflow, /checkout-history-mode:/);
  assert.equal(
    (workflow.match(/BUILDCHAIN_CHECKOUT_HISTORY_MODE: \$\{\{ inputs\.checkout-history-mode \}\}/g) || []).length,
    2,
  );
  assert.match(workflow, /shifu-cache-profile-ref:/);
  assert.match(workflow, /shifu-cache-profile-digest:/);
  assert.match(workflow, /compiler-cache-provider:/);
  assert.match(workflow, /compiler-cache-platforms-json:/);
  assert.match(workflow, /compiler-cache-required:/);
  assert.equal(
    (workflow.match(/SHIFU_CACHE_PROFILE_REF:/g) || []).length,
    6,
  );
  assert.equal(
    (workflow.match(/SHIFU_CACHE_PROFILE_DIGEST:/g) || []).length,
    8,
  );
  assert.equal(
    (workflow.match(/Prepare auditable compiler cache/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/node \.buildchain\/runtime\/scripts\/compiler-cache-evidence\.mjs prepare/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/Verify auditable compiler cache activity/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/node \.buildchain\/runtime\/scripts\/compiler-cache-evidence\.mjs verify/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/\.buildchain\/artifacts\/\$\{\{ matrix\.platform\.id \}\}\/compiler-cache-preparation\.json/g) || []).length,
    5,
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
  assert.match(workflow, /path: \|\n\s+\.buildchain\/workflow-shell\/scripts\/locked-source-checkout\.mjs/);
  assert.match(workflow, /\.buildchain\/workflow-shell\/scripts\/artifact-signing-delegation\.mjs/);
  assert.match(workflow, /\.buildchain\/workflow-shell\/scripts\/artifact-signing-controller\.mjs/);
  assert.match(workflow, /\.buildchain\/workflow-shell\/scripts\/artifact-signing-controller-core\.mjs/);
  assert.match(workflow, /\.buildchain\/workflow-shell\/scripts\/aws-runner-burst-core\.mjs/);
  assert.match(workflow, /\.buildchain\/workflow-shell\/scripts\/aws-windows-jit-core\.mjs/);
  assert.match(workflow, /\.buildchain\/workflow-shell\/scripts\/aws-macos-jit-core\.mjs/);
  assert.equal((workflow.match(/node \.buildchain\/runtime-bootstrap\/artifact-signing-delegation\.mjs seal/g) || []).length, 0);
  assert.equal(
    (workflow.match(/node \.buildchain\/runtime-bootstrap\/artifact-signing-controller\.mjs seal/g) || []).length,
    2,
  );
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
    5,
  );
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /artifact-transfer:/);
  assert.match(workflow, /INPUT_RELAY_REQUIRED:/);
  assert.match(workflow, /github-hosted-platform-ids-json:/);
  assert.match(workflow, /artifact-relay-s3\.mjs upload/);
  assert.match(workflow, /artifact-relay-s3\.mjs download/);
  assert.match(workflow, /artifact-relay-s3\.mjs cleanup/);
  assert.match(workflow, /aws-actions\/configure-aws-credentials@v6\.1\.0/);
  assert.match(workflow, /artifact-name \}\}-relay-manifest-\$\{\{ matrix\.platform\.id \}\}-/);
  assert.match(workflow, /relay-artifacts:/);
  assert.match(workflow, /needs\.artifact-transfer\.outputs\.mode == 'github-artifacts'/);
  assert.match(workflow, /needs\.artifact-transfer\.outputs\.mode == 's3-to-github-artifacts'/);
  assert.match(
    workflow,
    /needs\.artifact-transfer\.outputs\.mode == 'github-artifacts' \|\| matrix\.platform\.githubHosted == true/,
  );
  assert.match(
    workflow,
    /needs\.artifact-transfer\.outputs\.mode == 's3-to-github-artifacts' && matrix\.platform\.githubHosted != true/,
  );
  const deterministicPayloadUploads = [
    ...workflow.matchAll(
      /\n      - name: (?:Upload|Publish final signed) deterministic artifact\n([\s\S]*?)(?=\n      - name:|\n  [a-z])/g,
    ),
  ];
  assert.equal(deterministicPayloadUploads.length, 4);
  for (const [, uploadStep] of deterministicPayloadUploads) {
    assert.match(uploadStep, /include-hidden-files: true/);
  }
  const relayJob = workflow.slice(
    workflow.indexOf("\n  relay-artifacts:"),
    workflow.indexOf("\n  artifact-signing-control:"),
  );
  assert.equal(
    (relayJob.match(/if: \$\{\{ matrix\.platform\.githubHosted != true \}\}/g) || [])
      .length,
    9,
  );
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
  assert.match(workflow, /artifact-compression-level:/);
  assert.match(workflow, /default: 0/);
  assert.equal(
    (workflow.match(/name: Upload deterministic artifact[\s\S]*?compression-level: \$\{\{ inputs\.artifact-compression-level \}\}/g) || []).length,
    3,
  );
  assert.match(router, /artifact-compression-level: \$\{\{ inputs\.artifact-compression-level \}\}/);
});

test("publication artifact workflow exposes paper artifact contract", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/publication-artifact.yml"),
    "utf8",
  );
  const reproducibility = fs.readFileSync(
    path.join(root, "packages/core/publication-reproducibility.js"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /buildchain-contract-lock-path:/);
  assert.match(
    workflow,
    /buildchain-ref override is only allowed for trusted workflow_dispatch runs/,
  );
  assert.match(
    workflow,
    /buildchain-ref override requires write, maintain, or admin permission/,
  );
  assert.match(
    workflow,
    /BUILDCHAIN_RUNTIME_CLASS: \$\{\{ steps\.runtime\.outputs\.runtime-class \}\}/,
  );
  assert.match(workflow, /build-command:/);
  assert.match(workflow, /toolchain-type:/);
  assert.match(workflow, /toolchain-image:/);
  assert.match(
    workflow,
    /ghcr\.io\/kungfu-systems\/build-images\/latex-pdf-builder/,
  );
  assert.match(workflow, /toolchain-digest:/);
  assert.match(
    workflow,
    /sha256:c20f3809e96836c1c78e97c76939d12f1de3fed0ea9b7c40c43332ec2ea480f8/,
  );
  assert.match(workflow, /Resolve publication toolchain/);
  assert.match(reproducibility, /"docker", \["pull", toolchain\.imageRef\]/);
  assert.match(reproducibility, /"--network=none"/);
  assert.match(workflow, /BUILDCHAIN_PUBLICATION_TOOLCHAIN_TYPE/);
  assert.match(workflow, /verify-command:/);
  assert.match(workflow, /publication-artifact reproducibility/);
  assert.match(workflow, /--promote/);
  assert.match(
    workflow,
    /cat \.buildchain\/publication-reproducibility-result\.json[\s\S]*exit 1/,
  );
  assert.match(workflow, /reproducibility-receipt\.json/);
  assert.match(workflow, /receipt\.qualifying !== true/);
  assert.match(workflow, /qualified npm integrity changed/);
  assert.match(workflow, /publication-artifact-passport\.json/);
  assert.match(workflow, /publication-registry\.json/);
  assert.match(workflow, /publication-registry-path:/);
  assert.match(
    workflow,
    /registry-path=\$\{publication\.registryPath \|\| ""\}/,
  );
  assert.match(workflow, /source\.tar\.gz/);
  assert.match(
    workflow,
    /Upload publication artifact[\s\S]*include-hidden-files: true/,
  );
  assert.ok(
    workflow.indexOf("Check Buildchain contract lock") <
      workflow.indexOf("- name: Prove publication reproducibility"),
  );
  assert.ok(
    workflow.indexOf("- name: Verify publication") <
      workflow.indexOf("Read qualified publication artifact manifest"),
  );
  assert.ok(
    workflow.indexOf("Hydrate cumulative publication registry") <
      workflow.indexOf("Prove publication reproducibility"),
  );
});

test("paper release workflow publishes declared npm package with source lock and GitHub Release", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/paper-release.yml"),
    "utf8",
  );
  const sealedWorkflow = fs.readFileSync(
    path.join(root, ".github/workflows/paper-release-sealed.yml"),
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
  assert.match(
    sealedWorkflow,
    /KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY:[\s\S]*required: false/,
  );
  assert.match(
    sealedWorkflow,
    /uses: \.\/\.github\/workflows\/\.publication-authority\.yml[\s\S]*secrets: inherit/,
  );
  assert.match(workflow, /name: Seal paper publication capability/);
  assert.match(
    workflow,
    /name: Seal paper publication capability\n    permissions:\n      actions: read\n      checks: read\n      contents: read\n      pull-requests: read/,
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
  assert.match(
    docs,
    /paper-release-sealed\.yml@<exact-buildchain-sha>/,
  );
  assert.match(docs, /does not use a long-lived token for npm publication/);
  assert.match(
    docs,
    /GitHub App installation token[\s\S]*equivalent narrow compatibility authority/,
  );
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
        {
          role: "credential-input",
          artifactName: "libnode-credential-input-linux-x64",
          paths: ["dist/package.tgz"],
          required: true,
        },
      ],
    });
    assert.equal(manifest.contract, "kungfu-buildchain-artifact-relay-s3");
    assert.equal(manifest.groups.length, 4);
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
    assert.equal(
      fs.readFileSync(path.join(workspace, "relayed", "credential-input", "dist", "package.tgz"), "utf8"),
      "payload\n",
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
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const publicWorkflow = fs.readFileSync(
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(publicWorkflow, /publication-consumer-qualification-controller-sha:/);
  assert.match(
    publicWorkflow,
    /publication-consumer-qualification-controller-sha: \$\{\{ inputs\.publication-consumer-qualification-controller-sha \}\}/,
  );
  assert.match(
    publicWorkflow,
    /publication-authority-workflow-path: \.github\/workflows\/\.release-candidate-promote\.yml/,
  );
  assert.match(workflow, /^  promote:\s*$/m);
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
  assert.match(workflow, /publish-rematerialize-on-resume:/);
  assert.match(
    workflow,
    /publish-rematerialize-on-resume: \$\{\{ inputs\.publish-rematerialize-on-resume \}\}/,
  );
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
  assert.match(workflow, /release-passport-kfd-support-matrix-json:/);
  assert.match(workflow, /release-passport-kfd-support-matrix-json: \$\{\{ inputs\.release-passport-kfd-support-matrix-json \}\}/);
  assert.match(workflow, /release-passport-kfd-product-gate-jsons:/);
  assert.match(workflow, /release-passport-kfd-product-gate-jsons: \$\{\{ inputs\.release-passport-kfd-product-gate-jsons \}\}/);
  assert.match(workflow, /release-passport-invariant-passport-jsons:/);
  assert.match(workflow, /release-passport-invariant-passport-jsons: \$\{\{ inputs\.release-passport-invariant-passport-jsons \}\}/);
  assert.match(workflow, /release-passport-invariant-passport-command:/);
  assert.match(workflow, /release-passport-invariant-passport-command: \$\{\{ inputs\.release-passport-invariant-passport-command \}\}/);
  assert.match(workflow, /release-passport-evidence-jsons:/);
  assert.match(workflow, /release-passport-evidence-jsons: \$\{\{ inputs\.release-passport-evidence-jsons \}\}/);
  assert.match(workflow, /release-passport-attachment-command:/);
  assert.match(workflow, /release-passport-attachment-command: \$\{\{ inputs\.release-passport-attachment-command \}\}/);
  assert.match(workflow, /release-passport-buildchain-self-kfd:/);
  assert.match(workflow, /release-passport-buildchain-self-kfd: \$\{\{ inputs\.release-passport-buildchain-self-kfd \}\}/);
  assert.match(workflow, /github-artifact-attestation-policy-json:/);
  assert.match(workflow, /release-passport-github-artifact-attestation-policy-jsons: \$\{\{ steps\.attestation-policy\.outputs\.path \}\}/);
  assert.match(workflow, /name: Resolve GitHub artifact attestation policy/);
  assert.match(workflow, /release-candidate-github-artifact-attestation-policy-paths/);
  assert.match(
    workflow,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/github-artifact-attestation\.yml@375b2d4b8a904776453773a33b4c4e4556c8c999/,
  );
  assert.doesNotMatch(workflow, /github-artifact-attestation\.yml@v3/);
  assert.match(workflow, /buildchain-ref: \$\{\{ needs\.promote\.outputs\.github-artifact-attestation-signer-ref \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.promote\.outputs\.github-artifact-attestation-buildchain-ref \}\}/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /name: Publish verified attestation evidence to GitHub Release/);
  assert.match(workflow, /publish-github-artifact-attestation-evidence\.mjs/);
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
  assert.match(publicationPlan, /name: Validate consumer package manager contract/);
  assert.match(publicationPlan, /publish-transaction-override: \$\{\{ inputs\.publish-transaction-override \}\}/);
  assert.match(publicationPlan, /corepack pnpm install --frozen-lockfile/);
  assert.doesNotMatch(publicationPlan, /corepack pnpm@11\.7\.0/);
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
  assert.match(workflow, /INPUT_PUBLISH_TRANSACTION_OVERRIDE: \$\{\{ inputs\.publish-transaction-override \}\}/);
  assert.match(workflow, /const recoverableAdvance = durableRecovery && comparisonStatus === "ahead"/);
  assert.match(workflow, /const superseded = !dryRun && !recoverableAdvance && comparisonStatus === "ahead"/);
  assert.match(workflow, /!superseded && !recoverableAdvance/);
  assert.match(workflow, /moved incompatibly/);
  assert.match(workflow, /const action = superseded \? "noop" : "promote"/);
  assert.match(workflow, /"durable-transaction-recovery"/);
  assert.match(workflow, /publication-admission-json:/);
  assert.match(workflow, /publication-control-plane-audit-json:/);
  assert.match(workflow, /publication-gate-aggregate-json:/);
  assert.match(workflow, /publication-gate-command:/);
  assert.match(workflow, /publication-gate-controller-sha:/);
  assert.match(workflow, /publication-consumer-qualification-controller-sha:/);
  assert.match(workflow, /publication-authority-workflow-path:/);
  assert.match(workflow, /release-candidate-wait-seconds:/);
  assert.match(workflow, /publication-auto-admission:/);
  assert.match(workflow, /auto-admission: \$\{\{ inputs\.publication-auto-admission \}\}/);
  assert.match(workflow, /publication-auto-no-gate:/);
  assert.match(workflow, /auto-no-gate: \$\{\{ inputs\.publication-auto-no-gate \}\}/);
  assert.match(workflow, /consumer-gate-command: \$\{\{ inputs\.publication-gate-command \}\}/);
  assert.match(workflow, /consumer-gate-controller-sha: \$\{\{ inputs\.publication-gate-controller-sha \}\}/);
  assert.match(workflow, /BUILDCHAIN_RC_WAIT_SECONDS: \$\{\{ inputs\.release-candidate-wait-seconds \}\}/);
  assert.match(workflow, /source-sha: \$\{\{ needs\.preflight\.outputs\.requested-sha \}\}/);
  assert.match(workflow, /publisher-workflow-path: \$\{\{ inputs\.publication-publisher-workflow-path \}\}/);
  assert.match(workflow, /authority-workflow-path: \$\{\{ inputs\.publication-authority-workflow-path \}\}/);
  assert.match(workflow, /evidence-run-id:/);
  assert.match(workflow, /evidence-manifest-pattern:/);
  assert.match(workflow, /name: Seal product publication capability/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/\.publication-authority\.yml/);
  assert.match(workflow, /needs: \[preflight, controller-plan, release-candidate-preflight, publication-plan, publication-authority, publication-qualification\]/);
  assert.match(workflow, /needs\.publication-authority\.result == 'success'/);
  assert.match(workflow, /name: Bind consumer publication predicate/);
  assert.match(workflow, /name: Run consumer publication predicate/);
  assert.match(workflow, /BUILDCHAIN_CONSUMER_QUALIFICATION_CONTROLLER_SHA: \$\{\{ inputs\.publication-consumer-qualification-controller-sha \}\}/);
  assert.match(workflow, /const controllerSha = explicitControllerSha \|\| gateControllerSha \|\| sourceSha/);
  assert.match(workflow, /update\(`\$\{command\}\\0\$\{controllerSha\}`\)/);
  assert.match(workflow, /controller-sha=\$\{command \? controllerSha : ""\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.qualification-plan\.outputs\.controller-sha \}\}/);
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
  assert.match(
    workflow,
    /^ {4}environment: \$\{\{ inputs\.github-artifact-attestation-environment \}\}$/m,
  );
  assert.match(workflow, /token: \$\{\{ github\.token \}\}/);
  assert.match(
    workflow,
    /generated-ref-update-token: \$\{\{ github\.token \}\}/,
  );
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  assert.match(workflow, /if: \$\{\{ needs\.preflight\.outputs\.action == 'promote' \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.preflight\.outputs\.requested-sha \}\}/);
  assert.match(workflow, /INPUT_TARGET_SHA: \$\{\{ inputs\.target-sha \}\}/);
  assert.match(workflow, /Install promotion dependencies/);
  assert.match(workflow, /PACKAGE_MANAGER: \$\{\{ inputs\.package-manager \}\}/);
  assert.match(workflow, /corepack enable/);
  assert.match(workflow, /corepack pnpm install --frozen-lockfile/);
  assert.match(workflow, /cd "\$\{RECONCILIATION_WORKSPACE\}"[\s\S]*corepack pnpm install --frozen-lockfile/);
  assert.match(workflow, /Resolve post-release reconciliation checkout/);
  assert.match(workflow, /Checkout current development channel for reconciliation/);
  assert.match(workflow, /Install reconciliation dependencies/);
  assert.match(workflow, /workspace=\.buildchain\/reconciliation\/dev/);
  assert.match(workflow, /reconciliation-workspace: \$\{\{ steps\.reconciliation\.outputs\.workspace \}\}/);
  assert.match(workflow, /promote-only-release-candidate: "true"/);
  assert.match(workflow, /release-candidate-passport-path:/);
  assert.match(workflow, /release-candidate-build-summary-path:/);
  assert.match(workflow, /release-candidate-family-evidence-required:/);
  assert.match(workflow, /release-candidate-family-evidence-root:/);
  assert.match(workflow, /release-candidate-family-initiative-id:/);
  assert.match(workflow, /release-candidate-family-assignment-id:/);
  assert.match(workflow, /required-status-check: \$\{\{ inputs\.required-status-check \}\}/);
  assert.match(workflow, /allow-repository: \$\{\{ inputs\.allow-repository \|\| github\.repository \}\}/);
  assert.match(workflow, /publish-required-artifacts-json: \$\{\{ inputs\.publish-required-artifacts-json \}\}/);
  assert.match(workflow, /publish-required-artifacts-path: \$\{\{ inputs\.publish-required-artifacts-json == '' && steps\.rc\.outputs\.publish-required-artifacts-path \|\| '' \}\}/);
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
  assert.match(workflow, /release-candidate GitHub Release admission requires an empty publication-package-name and exact github-release:/);
  assert.match(workflow, /publisher_mode="github-token"/);
  assert.match(workflow, /release-candidate admission requires exactly one Gate aggregate, consumer Gate command, or explicit publication-auto-no-gate decision/);
  assert.match(workflow, /name: Checkout exact consumer Gate subject/);
  assert.match(workflow, /name: Checkout exact consumer Gate controller/);
  assert.match(workflow, /name: Assemble consumer Gate from exact downloaded evidence/);
  assert.match(workflow, /BUILDCHAIN_CONSUMER_GATE_COMMAND: \$\{\{ inputs\.consumer-gate-command \}\}/);
  assert.match(workflow, /consumer-gate-controller-sha:/);
  assert.match(workflow, /BUILDCHAIN_PUBLICATION_CONSUMER_CONTROLLER_SHA/);
  assert.match(workflow, /BUILDCHAIN_PUBLICATION_SUBJECT_ROOT/);
  assert.match(workflow, /consumerGateController/);
  assert.match(workflow, /BUILDCHAIN_PUBLICATION_GATE_RESULT_PATH/);
  assert.match(workflow, /rebindPublicationGateAggregateForEquivalentTree/);
  assert.match(workflow, /consumer-gate-evidence-source-sha:/);
  assert.match(workflow, /BUILDCHAIN_PUBLICATION_EVIDENCE_SOURCE_TREE/);
  assert.match(workflow, /name: Audit managed release-candidate publication control plane/);
  assert.match(workflow, /--repository "\$\{\{ inputs\.evidence-repository \}\}"/);
  assert.match(workflow, /--workflow-repository "\$\{\{ inputs\.buildchain-repository \}\}"/);
  assert.match(workflow, /--source-sha "\$\{\{ inputs\.source-sha \}\}"/);
  assert.match(workflow, /--workflow "\$\{\{ inputs\.authority-workflow-path \|\| '\.github\/workflows\/release-candidate-promote\.yml' \}\}"/);
  assert.match(workflow, /--workflow-ref "\$\{\{ inputs\.buildchain-ref \}\}"/);
  assert.match(workflow, /BUILDCHAIN_AUTHORITY_WORKFLOW_PATH: \$\{\{ inputs\.authority-workflow-path \|\| '\.github\/workflows\/release-candidate-promote\.yml' \}\}/);
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
  assert.match(script, /policyDigest: gateBindings\.policyDigest/);
  assert.doesNotMatch(script, /policyDigest: gateAggregate\.policyDigest/);
  assert.match(script, /github-hosted-single-job/);
  assert.match(script, /issuedAt\.getTime\(\) \+ 15 \* 60 \* 1000/);
  assert.doesNotMatch(script, /NODE_AUTH_TOKEN|NPM_TOKEN|BUILDCHAIN_PROMOTION_TOKEN/);
});

test("publication artifact admission uses validated Gate policy bindings", () => {
  const script = fs.readFileSync(
    path.join(root, "scripts/assemble-publication-artifact-admission.mjs"),
    "utf8",
  );
  assert.match(script, /policyDigest: gateBindings\.policyDigest/);
  assert.doesNotMatch(script, /policyDigest: gateAggregate\.policyDigest/);
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
  assert.match(script, /--allow-release-reconciliation/);
  assert.match(script, /evaluateBuildchainReleaseReconciliation/);
  assert.match(script, /release parent pull-request lineage/);
  assert.match(script, /observedAt\.getTime\(\) \+ 15 \* 60 \* 1000/);
  assert.match(script, /commits\/\$\{pullRequestHeadSha\}\/check-runs/);
  assert.doesNotMatch(script, /commits\/\$\{sourceSha\}\/check-runs/);
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
    assert.match(workflow, /release-candidate-promote\.yml@v3/);
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
  assert.match(workflow, /expected-pr-number:/);
  assert.match(workflow, /expected-head-sha:/);
  assert.match(workflow, /source-workflow-run-id:/);
  assert.match(workflow, /handoff-workflow-id:/);
  assert.match(workflow, /source-workflow-id:/);
  assert.match(workflow, /Legacy active Warrant source recovery requires a successful/);
  assert.match(workflow, /\.head_sha == \$head/);
  assert.match(workflow, /sort_by\(\.id\)/);
  assert.match(workflow, /last \| \.id/);
  assert.match(workflow, /active-warrant-handoff-dispatched/);
  assert.match(workflow, /gh workflow run "\$HANDOFF_WORKFLOW_ID"/);
  assert.match(workflow, /diagnostic-context:/);
  assert.match(workflow, /required-status-checks:/);
  assert.match(workflow, /queue-admission-context:/);
  assert.match(workflow, /default: "check \/ check"/);
  assert.match(workflow, /ready-label:/);
  assert.match(workflow, /block-labels:/);
  assert.match(workflow, /allowed-head-prefixes:/);
  assert.match(workflow, /require-approval:/);
  assert.match(workflow, /same-repository-only:/);
  assert.match(workflow, /max-merges:/);
  assert.match(workflow, /landing-mode:/);
  assert.match(workflow, /default: "auto"/);
  assert.match(workflow, /enqueued-count:/);
  assert.match(workflow, /action-count:/);
  assert.match(workflow, /admission-state:/);
  assert.match(workflow, /admission-receipt-root:/);
  assert.match(workflow, /dry-run:/);
  assert.match(workflow, /default: true/);
  assert.match(workflow, /dev\/v\*\/v\*/);
  assert.match(workflow, /Checkout Buildchain runtime/);
  assert.match(workflow, /dev-pr-auto-merge\.mjs/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /checks: read/);
  assert.match(workflow, /statuses: write/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /Qualify exact source before scheduling[\s\S]*--landing-mode queue[\s\S]*--qualification-only/);
  assert.match(workflow, /Enforce targeted admission result/);
  assert.match(workflow, /buildchain-dev-pr-admission-/);
  assert.match(workflow, /BUILDCHAIN_DEV_PR_LANDING_MODE: \$\{\{ inputs\.landing-mode \}\}/);
  assert.match(workflow, /BUILDCHAIN_DEV_PR_QUEUE_ADMISSION_CONTEXT:/);
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);

  const verify = fs.readFileSync(path.join(root, ".github/workflows/verify.yml"), "utf8");
  assert.match(verify, /pull_request:/);
  assert.match(verify, /merge_group:/);
  assert.match(verify, /types: \[checks_requested\]/);
  assert.doesNotMatch(verify, /github\.event\.pull_request/);
});

test("queued Warrant cancellation workflow binds exact terminal event authority", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/dev-delivery-warrant-cancel.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /expected-candidate-id:/);
  assert.match(workflow, /expected-source-head-sha:/);
  assert.match(workflow, /observed-source-head-sha:/);
  assert.match(workflow, /expected-old-state-root:/);
  assert.match(workflow, /terminal-evidence-root:/);
  assert.match(workflow, /cancel-queued/);
  assert.match(workflow, /--expected-old/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /actions\/checkout@v7\.0\.0/);
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
});

test("terminal Warrant close ignores stale dequeue events after exact re-enqueue", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/dev-delivery-warrant-close.yml"), "utf8");
  assert.match(workflow, /mode=stale-dequeued/);
  assert.match(workflow, /The exact PR head is still queued/);
  assert.match(workflow, /mergeQueue\(branch:\$branch\)/);
  assert.match(workflow, /steps\.settlement\.outputs\.mode != 'stale-dequeued'/);
});

test("Buildchain self-delivery requires an exact Warrant before Merge Queue admission", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-dev-delivery.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /expected-pr-number:/);
  assert.match(workflow, /expected-head-sha:/);
  assert.match(workflow, /native-roots-json:/);
  assert.match(workflow, /expected-pr-number: \$\{\{ fromJSON\(github\.event\.inputs\.expected-pr-number\) \}\}/);
  assert.match(workflow, /assignment-root: \$\{\{ fromJSON\(github\.event\.inputs\.native-roots-json\)\.assignmentRoot \}\}/);
  assert.match(workflow, /initiative-root: \$\{\{ fromJSON\(github\.event\.inputs\.native-roots-json\)\.initiativeRoot \}\}/);
  assert.match(workflow, /source-identity-root:/);
  assert.match(workflow, /source-patch-root:/);
  assert.match(workflow, /plan-root:/);
  assert.match(workflow, /closure-root:/);
  assert.match(workflow, /dependency-root:/);
  assert.match(workflow, /toolchain-root:/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/dev-pr-auto-merge\.yml/);
  assert.match(workflow, /buildchain-ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /permissions:\n  actions: write/);
  assert.match(workflow, /delivery-warrant-mode: required/);
  assert.match(workflow, /delivery-class: native-proof-required/);
  assert.match(workflow, /delivery-priority: ordinary/);
  assert.match(workflow, /required-status-checks: check/);
  assert.match(
    workflow,
    /allowed-head-prefixes: feature\/,fix\/,chore\/,docs\/,ci\/,refactor\/,automation\/auditable-demo-/,
  );
  assert.match(workflow, /landing-mode: queue/);
  assert.match(workflow, /dry-run: false/);
  assert.match(workflow, /github-token: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \}\}/);
  assert.match(workflow, /run-name: "Buildchain PR #\$\{\{ inputs\.expected-pr-number \}\} · required Delivery Warrant"/);
  const controller = fs.readFileSync(
    path.join(root, ".github/workflows/dev-pr-auto-merge.yml"),
    "utf8",
  );
  assert.match(controller, /branches\/\$encoded_branch\/protection/);
  assert.match(controller, /grep -q 'HTTP 404'/);
  assert.match(controller, /rules\/branches\/\$encoded_branch/);
  assert.match(controller, /\.type == "update"/);
  assert.doesNotMatch(workflow, /secrets: inherit/);
  assert.doesNotMatch(workflow, /delivery-warrant-mode: off/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf("    with:")), /\$\{\{ inputs\./);
  const dispatchInputs = workflow
    .slice(workflow.indexOf("    inputs:"), workflow.indexOf("\npermissions:"))
    .match(/^      [a-z][a-z0-9-]+:$/gmu);
  assert.equal(dispatchInputs?.length, 10);
});

test("declared merge queue governance reconciles automatically on dev changes", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/dev-merge-queue-governance.yml"),
    "utf8",
  );
  assert.match(workflow, /push:\n\s+branches:\n\s+- dev\/v\*\/v\*/);
  assert.match(workflow, /\.buildchain\/buildchain\.toml/);
  assert.match(
    workflow,
    /BUILDCHAIN_GOVERNANCE_TOKEN \|\| secrets\.BUILDCHAIN_PROMOTION_TOKEN \|\| github\.token/,
  );
  assert.match(workflow, /--from-config/);
  assert.match(workflow, /github\.event_name == 'push' \|\| inputs\.apply/);
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
  assert.match(dogfoodDaily, /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v3-alpha' \}\}/);
  assert.match(dogfoodDaily, /landing-mode: queue/);
  assert.doesNotMatch(dogfoodDaily, /target-branch: dev\/v2\/v2\.\d+/);
  assert.match(dogfoodDaily, /dry-run: \$\{\{ inputs\.dry-run \|\| false \}\}/);
  assert.match(dogfoodDaily, /contents: write/);
  assert.match(dogfoodDaily, /pull-requests: write/);
  assert.match(dogfoodWeekly, /schedule:/);
  assert.match(dogfoodWeekly, /uses: \.\/\.github\/workflows\/patrol-weekly\.yml/);
  assert.match(dogfoodWeekly, /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v3-alpha' \}\}/);
  assert.doesNotMatch(dogfoodWeekly, /target-branch: dev\/v2\/v2\.\d+/);
  assert.match(dogfoodWeekly, /contents: write/);
  assert.match(dogfoodWeekly, /pull-requests: write/);
  assert.match(dogfoodMonthly, /schedule:/);
  assert.match(dogfoodMonthly, /uses: \.\/\.github\/workflows\/patrol-monthly\.yml/);
  assert.match(dogfoodMonthly, /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v3-alpha' \}\}/);
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
  assert.match(dogfood, /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v3-alpha' \}\}/);
  assert.match(dogfood, /promotion-token: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \}\}/);
  assert.match(
    dogfood,
    /approval-token: \$\{\{ secrets\.BUILDCHAIN_APPROVAL_TOKEN \|\| secrets\.KUNGFU_GITHUB_TOKEN \}\}/,
  );
  assert.match(qualification, /workflows: \["Buildchain Alpha Self-Dogfood"\]/);
  assert.match(qualification, /statuses: write/);
  assert.match(qualification, /GITHUB_TOKEN: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \}\}/);
  assert.match(qualification, /BUILDCHAIN_QUALIFICATION_ATTESTATION_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(qualification, /name: buildchain-v3-alpha-self-dogfood-evidence/);
  assert.match(qualification, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(qualification, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
  assert.doesNotMatch(qualification, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| inputs\.candidate-sha \}\}/);
  assert.match(qualification, /BUILDCHAIN_QUALIFICATION_CANDIDATE_SHA: \$\{\{ steps\.candidate\.outputs\.sha \}\}/);
  assert.doesNotMatch(qualification, /BUILDCHAIN_QUALIFICATION_CANDIDATE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha/);
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
  assert.doesNotMatch(workflow, /production-apply requires production-approved=true before production build or deploy/);
  assert.doesNotMatch(workflow, /production-apply requires a trusted manual actor or reviewed matching release PR/);
  assert.match(
    workflow,
    /\[ "\$PRODUCTION_APPLY" = "true" \] && \[ "\$production_event_approved" = "true" \] && \[ -z "\$PRODUCTION_ROLE_ARN" \]/,
  );
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
  assert.match(
    workflow,
    /release-intent:\n    name: Resolve production release PR intent\n    runs-on: ubuntu-24\.04\n    permissions:\n      pull-requests: read/,
  );
  assert.match(workflow, /listPullRequestsAssociatedWithCommit/);
  assert.match(workflow, /closedPullRequest/);
  assert.match(workflow, /context\.payload\.pull_request/);
  assert.match(workflow, /releasePull\.merge_commit_sha/);
  assert.match(workflow, /production-source-sha/);
  assert.match(workflow, /associated-release-pr-merged/);
  assert.match(workflow, /closed-release-pr-merged/);
  assert.match(workflow, /no-associated-release-pr/);
  assert.match(workflow, /Comment release PR staging review URL/);
  assert.match(workflow, /web-surface-release-pr-review\.mjs/);
  assert.match(workflow, /Plan pull request preview/);
  assert.match(workflow, /github\.event\.action != 'closed'/);
  assert.match(workflow, /Plan pull request preview cleanup/);
  assert.match(
    workflow,
    /github\.event\.action == 'closed' && needs\.release-intent\.outputs\.production-release-approved != 'true'/,
  );
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
  assert.match(workflow, /needs\.publication-decision\.outputs\.approved == 'true'/);
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
  assert.match(workflow, /Seal managed web production publication capability/);
  assert.match(
    workflow,
    /name: Verify external web production publication capability[\s\S]*?permissions:\n      actions: read\n      checks: read\n      contents: read\n      pull-requests: read[\s\S]*?uses: \.\/\.github\/workflows\/\.publication-authority\.yml/,
  );
  assert.match(workflow, /uses: \.\/\.github\/workflows\/\.publication-authority\.yml/);
  assert.match(workflow, /publication-admission-json:/);
  assert.match(workflow, /publication-control-plane-audit-json:/);
  assert.match(workflow, /publication-gate-aggregate-json:/);
  assert.match(workflow, /- publication-authority/);
  assert.match(workflow, /inputs\.production-apply/);
  assert.match(workflow, /BUILDCHAIN_PRODUCTION_APPROVED: \$\{\{ inputs\.production-approved \}\}/);
  assert.match(workflow, /BUILDCHAIN_PRODUCTION_RELEASE_ON_MAIN: \$\{\{ inputs\.production-release-on-main \}\}/);
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

test("web-surface side-effect jobs and sealed production paths have explicit authority", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.web-surface.yml"),
    "utf8",
  );
  const job = (id) => {
    const match = workflow.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\n|\\Z)`, "m"));
    assert.ok(match, `missing job ${id}`);
    return match[0];
  };
  const plan = job("plan");
  assert.match(plan, /pull-requests: write/);
  assert.match(plan, /issues: write/);
  assert.match(plan, /web-surface-release-pr-review\.mjs/);
  assert.match(plan, /uses: \.\/\.buildchain\/runtime\/actions\/report-buildchain-issue/);

  const decision = job("publication-decision");
  assert.match(decision, /web-surface-production-decision\.mjs/);
  assert.match(decision, /BUILDCHAIN_PRODUCTION_RELEASE_APPROVED/);
  const inputGate = job("apply-input-gate");
  assert.doesNotMatch(inputGate, /production-apply requires a trusted manual actor/);
  assert.match(inputGate, /if \[ "\$production_event_approved" = "true" \]; then\n\s+web_surface_channel=production/);
  assert.ok(
    inputGate.indexOf('if [ "$production_event_approved" = "true" ]') <
      inputGate.indexOf('elif [ "$EVENT_NAME" = "pull_request" ]'),
  );
  const authority = job("publication-authority");
  assert.match(authority, /Create qualifying pre-publication controller receipt/);
  assert.match(authority, /assemble-web-surface-publication-admission\.mjs/);
  assert.match(authority, /needs\.publication-decision\.outputs\.approved == 'true'/);
  const production = job("production-apply");
  assert.match(production, /needs\.publication-authority\.result == 'success'/);
  assert.match(production, /needs\.external-publication-authority\.result == 'success'/);
  assert.ok(
    production.indexOf("Verify sealed production capability before artifact download") <
      production.indexOf("Download web-surface artifact"),
  );
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

test("web-surface production release PR suppresses a duplicate for a merged release push", async () => {
  const previousFetch = globalThis.fetch;
  const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url).includes(`/commits/${sourceSha}/pulls?`)) {
      return new Response(JSON.stringify([{
        number: 42,
        html_url: "https://github.com/kungfu-systems/site-libkungfu-dev/pull/42",
        merged_at: "2026-07-26T00:00:00Z",
        base: { ref: "main" },
        head: {
          ref: "release/production-abcdef123456",
          repo: { full_name: "kungfu-systems/site-libkungfu-dev" },
        },
        labels: [{ name: "buildchain-release" }],
      }]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${options.method || "GET"} ${url}`);
  };
  try {
    const result = await openProductionReleasePr({
      token: "token",
      repository: "kungfu-systems/site-libkungfu-dev",
      sourceSha,
      stagingResult: { channel: "staging", status: "applied" },
    });
    assert.equal(result.status, "suppressed-merged-release-pr");
    assert.equal(result.pullNumber, 42);
    assert.equal(calls.length, 1);
    assert.equal(calls.some((call) => call.method === "POST"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("web-surface production release PR finds a merged intent by deterministic head", async () => {
  const previousFetch = globalThis.fetch;
  const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url).includes(`/commits/${sourceSha}/pulls?`)) {
      return new Response(JSON.stringify([{
        number: 41,
        merged_at: "2026-07-25T23:59:00Z",
        base: { ref: "main" },
        head: {
          ref: "fix/preceding-source-change",
          repo: { full_name: "kungfu-systems/site-libkungfu-dev" },
        },
        labels: [],
      }]), { status: 200 });
    }
    if (String(url).includes("/pulls?state=closed&base=main&head=kungfu-systems%3Arelease%2Fproduction-abcdef123456")) {
      return new Response(JSON.stringify([{
        number: 42,
        html_url: "https://github.com/kungfu-systems/site-libkungfu-dev/pull/42",
        merged_at: "2026-07-26T00:00:00Z",
        base: { ref: "main" },
        head: {
          ref: "release/production-abcdef123456",
          repo: { full_name: "kungfu-systems/site-libkungfu-dev" },
        },
        labels: [{ name: "buildchain-release" }],
      }]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${options.method || "GET"} ${url}`);
  };
  try {
    const result = await openProductionReleasePr({
      token: "token",
      repository: "kungfu-systems/site-libkungfu-dev",
      sourceSha,
      stagingResult: { channel: "staging", status: "applied" },
    });
    assert.equal(result.status, "suppressed-merged-release-pr");
    assert.equal(result.pullNumber, 42);
    assert.equal(calls.length, 2);
    assert.equal(calls.every((call) => call.method === "GET"), true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("web-surface release-intent suppression records a durable control-plane outcome", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-pr-suppression-event-"));
  const logPath = path.join(workspace, ".buildchain", "logs", "events.jsonl");
  recordProductionReleasePrOutcome({
    action: "suppressed-merged-release-pr",
    status: "suppressed-merged-release-pr",
    suppressionReason: "source-commit-already-has-qualifying-merged-release-pr",
    repository: "kungfu-systems/site-libkungfu-dev",
    productionReleaseChannel: "production",
    pullNumber: 42,
    sourceSha: "abcdef1234567890abcdef1234567890abcdef12",
  }, { BUILDCHAIN_LOG_PATH: logPath });

  const event = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
  assert.equal(event.event, "control-plane.release-intent.outcome");
  assert.equal(event.attributes.outcome, "suppressed");
  assert.equal(
    event.attributes.reason,
    "source-commit-already-has-qualifying-merged-release-pr",
  );
});

test("web-surface production release PR permission-denied is a non-fatal handoff", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-pr-permission-"));
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
  const summaryPath = path.join(workspace, "staging-summary.json");
  const outputPath = path.join(workspace, "github-output.txt");
  const stepSummaryPath = path.join(workspace, "step-summary.md");
  const logPath = path.join(workspace, ".buildchain", "logs", "events.jsonl");
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
    if (String(url).includes(`/commits/${sourceSha}/pulls?`)) return new Response("[]", { status: 200 });
    if (String(url).includes("/pulls?state=closed")) return new Response("[]", { status: 200 });
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
      BUILDCHAIN_LOG_PATH: logPath,
    });
    assert.equal(result.status, "permission-denied");
    assert.match(fs.readFileSync(outputPath, "utf8"), /release-pr-status=permission-denied/);
    assert.match(fs.readFileSync(outputPath, "utf8"), /production-release-token-source=github-token/);
    assert.match(fs.readFileSync(stepSummaryPath, "utf8"), /Manual PR creation command/);
    const handoff = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/production-release-pr/handoff.json"), "utf8"));
    assert.equal(handoff.status, "permission-denied");
    assert.equal(handoff.error.status, 403);
    assert.equal(handoff.tokenSource, "github-token");
    const event = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(event.event, "control-plane.release-intent.outcome");
    assert.equal(event.attributes.outcome, "failed");
    assert.equal(event.attributes.action, "permission-denied");
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
  const publicPublication = fs.readFileSync(
    path.join(root, ".github/workflows/binary-release-assets.yml"),
    "utf8",
  );
  const authority = fs.readFileSync(
    path.join(root, ".github/workflows/.publication-authority.yml"),
    "utf8",
  );
  const promotion = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const assembler = fs.readFileSync(
    path.join(root, "scripts/assemble-binary-release-admission.mjs"),
    "utf8",
  );
  assert.match(workflow, /Fetch durable release-state passport/);
  assert.match(workflow, /name: Write checksums[\s\S]*?! -name checksums\.txt/);
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
  assert.match(
    publication,
    /name: Seal binary release asset capability\n    permissions:\n      actions: read\n      checks: read\n      contents: read\n      pull-requests: read/,
  );
  assert.match(publication, /needs: publication-authority/);
  assert.match(publication, /environment: buildchain-release-assets/);
  assert.match(publication, /scripts\/ensure-github-release\.mjs/);
  assert.match(publication, /name: Write public binary checksums/);
  assert.match(publication, /! -name checksums\.txt/);
  assert.match(publication, /dist\/binary\/\*/);
  assert.match(publication, /--repository "\$\{\{ github\.repository \}\}"/);
  assert.match(publication, /--tag "\$RELEASE_TAG"/);
  assert.match(publication, /gh release upload "\$RELEASE_TAG"/);
  assert.match(publication, /capability\.artifactDigest !== actualArtifact/);
  assert.match(workflow, /BUILDCHAIN_CONTROLLER_ID: binary-distribution/);
  assert.match(workflow, /buildchain-controller-binary-distribution/);
  assert.match(workflow, /controller-receipt-qualifying != 'true'/);
  assert.match(workflow, /name: Dispatch sealed binary asset publication/);
  assert.match(workflow, /needs: passport/);
  assert.match(workflow, /name: Dispatch exact evidence run to Binary Release Assets/);
  assert.match(workflow, /gh workflow run binary-release-assets\.yml/);
  assert.match(workflow, /-f evidence-run-id="\$\{GITHUB_RUN_ID\}"/);
  assert.doesNotMatch(publicPublication, /workflow_run:/);
  assert.match(
    publicPublication,
    /uses: \.\/\.github\/workflows\/\.binary-release-assets\.yml\n    permissions:\n      actions: read\n      checks: read\n      contents: write\n      pull-requests: read\n    secrets: inherit/,
  );
  assert.match(
    publication,
    /uses: \.\/\.github\/workflows\/\.publication-authority\.yml\n    secrets: inherit/,
  );
  assert.match(publicPublication, /Binary Distribution source \$source_sha does not match \$release_tag/);
  assert.match(publicPublication, /manual buildchain-ref must equal the exact workflow source SHA/);
  assert.match(authority, /--allow-release-reconciliation/);
  assert.match(authority, /--environment-ref "v\$\{\{ inputs\.publication-version \}\}"/);
  assert.match(authority, /--environment-ref-type tag/);
  assert.match(authority, /BUILDCHAIN_AUTHORITY_REF: \$\{\{ inputs\.buildchain-ref \}\}/);
  assert.match(authority, /actualRuntimeSha !== expectedAuthorityRuntimeSha/);
  assert.match(
    authority,
    /BUILDCHAIN_AUTO_ADMISSION_KIND !== "binary-release-assets"[\s\S]*?capability\.runtimeSha !== actualRuntimeSha/,
  );
  assert.match(publicPublication, /auto-admission: true/);
  assert.match(publication, /auto-admission-kind: binary-release-assets/);
  assert.match(publication, /gate-aggregate-json:/);
  assert.match(promotion, /Dispatch standalone binary distribution for the exact public tag/);
  assert.match(promotion, /gh workflow run binary-distribution\.yml/);
  assert.match(
    promotion,
    /steps\.promote\.outputs\.finalization-needed != 'true'[\s\S]*?steps\.promote\.outputs\.public-release-tag != ''/,
  );
  assert.match(
    promotion,
    /name: Preflight PR-stage release candidate evidence[\s\S]*?permissions:\n      actions: read\n      contents: read/,
  );
  assert.match(
    promotion,
    /name: Promote release candidate[\s\S]*?permissions:\n      actions: write\n      checks: write/,
  );
  assert.match(assembler, /validateControllerReceipt/);
  assert.match(assembler, /validateControllerPlan/);
  assert.match(assembler, /oneFile\(controllerRoot, "plan\.json"\)/);
  assert.match(assembler, /plan: controllerPlan/);
  assert.doesNotMatch(assembler, /expectedRuntimeSha: runtimeSha/);
  assert.match(assembler, /buildchain-aarch64-apple-darwin\.tar\.gz/);
  assert.match(assembler, /buildchain-x86_64-unknown-linux-gnu\.tar\.gz/);
  assert.match(assembler, /buildchain-x86_64-pc-windows-msvc\.zip/);
  assert.doesNotMatch(workflow, /gh release create/);
});

test("npm-only promotion does not require a standalone binary workflow", () => {
  const promotion = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const selfPromotion = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-ref-promotion.yml"),
    "utf8",
  );
  assert.match(
    promotion,
    /standalone-binary-distribution:\n\s+description: "Dispatch binary-distribution\.yml after promotion; enable only when the caller repository provides that workflow"\n\s+default: false/,
  );
  assert.match(
    promotion,
    /if: \$\{\{ inputs\.standalone-binary-distribution && !inputs\.dry-run && steps\.promote\.outcome == 'success'/,
  );
  assert.match(
    selfPromotion,
    /standalone-binary-distribution: \$\{\{ inputs\['resume-candidate-run-id'\] == '' \}\}/,
  );
  assert.match(
    selfPromotion,
    /recover-durable-transaction:[\s\S]*?type: boolean/,
  );
  assert.match(
    selfPromotion,
    /recover-durable-transaction'\] == true && inputs\.sha != ''/,
  );
  assert.match(
    selfPromotion,
    /publication-auto-admission: \$\{\{ github\.event_name == 'workflow_run' \|\| inputs\['recover-durable-transaction'\] == true \|\| inputs\['resume-candidate-run-id'\] != '' \}\}/,
  );
  assert.match(
    selfPromotion,
    /recover-durable-transaction:[\s\S]*?Recover an existing durable transaction from its exact original source SHA/,
  );
  assert.match(
    selfPromotion,
    /reject-invalid-durable-recovery:[\s\S]*?Durable transaction recovery requires the exact original transaction source SHA/,
  );
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
    "v3",
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
      workflowShellRef: "v3",
      rollbackRef: "v3",
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
  assert.deepEqual(
    resolveRuntimeSelection({
      requestedRef: "a".repeat(40),
      workflowRef: `kungfu-systems/buildchain/.github/workflows/publication-artifact.yml@${"a".repeat(40)}`,
    }),
    {
      requestedRef: "a".repeat(40),
      runtimeRef: "a".repeat(40),
      runtimeFullRef: "a".repeat(40),
      runtimeClass: "exact-sha",
      runtimeOverride: false,
      workflowShellRef: "a".repeat(40),
      rollbackRef: "a".repeat(40),
      trustDecision: "pinned-self",
    },
  );
  assert.equal(
    normalizeRequestedRuntimeRef("refs/heads/train/v2/v2.3/runtime-loader").ref,
    "train/v2/v2.3/runtime-loader",
  );
  assert.equal(classifyBuildchainRuntimeRef("train/v2/v2.3/runtime-loader"), "train");
  assert.equal(
    normalizeRequestedRuntimeRef("refs/heads/authority/v3/v3.0/artifact-signing").ref,
    "authority/v3/v3.0/artifact-signing",
  );
  assert.equal(classifyBuildchainRuntimeRef("authority/v3/v3.0/artifact-signing"), "authority");
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
  assert.deepEqual(
    validateRuntimeOverrideTrust({
      requestedRef: "a".repeat(40),
      eventName: "push",
      sameRepositoryWorkflow: true,
      workflowShellSha: "a".repeat(40),
    }),
    { ok: true, decision: "pinned-self" },
  );
  assert.equal(
    validateRuntimeOverrideTrust({
      requestedRef: "a".repeat(40),
      eventName: "push",
      sameRepositoryWorkflow: true,
      workflowShellSha: "b".repeat(40),
    }).ok,
    false,
  );
  assert.deepEqual(
    validateRuntimeOverrideTrust({
      requestedRef: "a".repeat(40),
      eventName: "pull_request",
      sameRepositoryPullRequest: true,
      pullRequestHeadSha: "a".repeat(40),
    }),
    { ok: true, decision: "same-repository-pr-head" },
  );
  assert.deepEqual(
    validateRuntimeOverrideTrust({
      requestedRef: "a".repeat(40),
      eventName: "pull_request",
      eventAction: "closed",
      workflowShellSha: "a".repeat(40),
    }),
    { ok: true, decision: "closed-release-pr-shell-runtime" },
  );
  assert.equal(
    validateRuntimeOverrideTrust({
      requestedRef: "a".repeat(40),
      eventName: "pull_request",
      eventAction: "closed",
      workflowShellSha: "b".repeat(40),
    }).ok,
    false,
  );
  assert.equal(
    validateRuntimeOverrideTrust({
      requestedRef: "a".repeat(40),
      eventName: "pull_request",
      sameRepositoryPullRequest: true,
      pullRequestHeadSha: "b".repeat(40),
    }).ok,
    false,
  );
  assert.equal(
    validateRuntimeOverrideTrust({
      requestedRef: "train/v2/v2.3/runtime-loader",
      eventName: "workflow_dispatch",
      actorPermission: "write",
    }).decision,
    "override-accepted",
  );
  assert.equal(
    validateRuntimeOverrideTrust({
      requestedRef: "authority/v3/v3.0/artifact-signing",
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
    if (
      workflowFile === ".github/workflows/.build.yml" ||
      workflowFile === ".github/workflows/paper-release.yml" ||
      workflowFile === ".github/workflows/publication-artifact.yml"
    ) {
      assert.match(workflow, /const pinnedSelfRuntime =/);
      assert.match(workflow, /requested\.toLowerCase\(\) === shellRef\.toLowerCase\(\)/);
      assert.match(workflow, /requested !== "" && !officialChannel && !pinnedSelfRuntime/);
      assert.match(workflow, /\? "pinned-self"/);
    } else {
      assert.match(workflow, /requested !== "" && !officialChannel/);
    }
    assert.match(workflow, /\? "official-channel"/);
    assert.match(workflow, /buildchain-ref override is only allowed for trusted workflow_dispatch runs/);
  }
});

test("web-surface release PR close hands production to the protected main push", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.web-surface.yml"), "utf8");
  assert.match(workflow, /trustedClosedReleasePrRuntime/);
  assert.match(workflow, /requested\.toLowerCase\(\) === \(await resolveRef\(shellRef\)\)\.toLowerCase\(\)/);
  assert.match(workflow, /closed-release-pr-shell-runtime/);
  assert.match(workflow, /EVENT_ACTION" = "closed"[\s\S]*?web_surface_channel=""/);
  assert.match(
    fs.readFileSync(path.join(root, "scripts/web-surface-production-decision.mjs"), "utf8"),
    /release-pr-verified-awaiting-main-push/,
  );
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

test("Gate profile treats its exact workflow shell SHA as a pinned self runtime", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.gate-profile.yml"), "utf8");
  assert.match(workflow, /const pinnedSelfRuntime =/);
  assert.match(workflow, /sameRepositoryWorkflow &&[\s\S]*exactSha\.test\(requested\)[\s\S]*exactSha\.test\(shellRef\)/);
  assert.match(workflow, /requested\.toLowerCase\(\) === shellRef\.toLowerCase\(\)/);
  assert.match(workflow, /requested && !official\.test\(requested\) && !pinnedSelfRuntime/);
});

test("build workflow only trusts an exact same-repository pull request head override", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  assert.match(workflow, /const trustedSameRepositoryPullRequestHead =/);
  assert.match(workflow, /pullRequestHeadRepository === repository/);
  assert.match(workflow, /requested\.toLowerCase\(\) === pullRequestHeadSha\.toLowerCase\(\)/);
  assert.match(workflow, /!trustedSameRepositoryPullRequestHead && context\.eventName !== "workflow_dispatch"/);
  assert.match(workflow, /\? "same-repository-pr-head"/);
});
