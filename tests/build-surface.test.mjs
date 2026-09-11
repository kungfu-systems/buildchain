import { createS3ObjectClient } from "../packages/core/providers/artifact-relay/s3-client.js";
import { compactProductionReleasePrSummary } from "../packages/core/web/release-pr-summary.js";
import { admitWebApplyInputs } from "../packages/core/web/apply-admission.js";
import { inspectWorkflowJob, readWorkflow } from "../scripts/workflow-action-graph.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
import { resolvePublishSourceCli } from "../packages/core/release/commands/resolve-publish-source.mjs";
import { evaluateBuildchainContractLock } from "../packages/core/contracts/buildchain-contract.js";
import {
  canAdmitSelfDogfoodLockEvaluation,
  contractForSelfDogfoodEvaluation,
  resolveSelfDogfoodMajor,
} from "../packages/core/release/self-dogfood-version.js";
import { runLifecycle } from "../packages/core/build/lifecycle/transaction.js";
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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepoText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("every workflow v2 token is explicitly governed and no ungoverned runtime default remains", () => {
  const inventory = JSON.parse(
    fs.readFileSync(
      path.join(root, "contracts/buildchain-v2-residuals-v1.json"),
      "utf8",
    ),
  );
  assert.equal(inventory.contract, "buildchain.v2-residual-inventory/v1");
  assert.equal(inventory.policy.runtimeDefault, "v4");
  assert.equal(inventory.policy.dogfoodRuntimeDefault, "v4-alpha");
  assert.equal(inventory.policy.unclassifiedV2TokensAllowed, false);

  const allowedClassifications = new Set([
    "third-party-action-version",
  ]);
  for (const entry of inventory.entries) {
    assert.ok(
      entry.path.startsWith(".github/workflows/"),
      `${entry.path} must be a workflow`,
    );
    assert.ok(
      entry.token.toLowerCase().includes("v2"),
      `${entry.path} token must identify v2`,
    );
    assert.ok(
      Number.isInteger(entry.expectedOccurrences) &&
        entry.expectedOccurrences > 0,
    );
    assert.ok(
      allowedClassifications.has(entry.classification),
      `${entry.path} classification must be governed`,
    );
    assert.ok(entry.callerStatus, `${entry.path} must declare caller status`);
    assert.ok(entry.owner, `${entry.path} must declare an owner`);
    assert.ok(
      entry.sunsetCondition,
      `${entry.path} must declare a sunset condition`,
    );

    const source = readRepoText(entry.path);
    assert.equal(
      source.split(entry.token).length - 1,
      entry.expectedOccurrences,
      `${entry.path} residual count drifted for ${entry.token}`,
    );
  }

  const workflowDir = path.join(root, ".github/workflows");
  for (const name of fs
    .readdirSync(workflowDir)
    .filter((entry) => /\.ya?ml$/.test(entry))) {
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
    ".github/workflows/public-build-check.yml",
    ".github/workflows/.build-gate-profile.yml",
    ".github/workflows/public-release-web.yml",
    ".github/workflows/public-build-publication.yml",
    ".github/workflows/public-release-paper.yml",
    ".github/workflows/public-release-propagation.yml",
  ];
  assert.match(readRepoText(".github/workflows/.build.yml"), /result:/u);
  assert.match(readRepoText("packages/core/build/summary/finalization.js"), /controllerReceipt/u);
  for (const workflow of workflows) {
    const source = readRepoText(workflow);
    assert.match(
      source,
      /controller-plan-artifact:/,
      `${workflow} must expose its plan artifact`,
    );
    assert.match(
      source,
      /controller-plan-digest:/,
      `${workflow} must expose its plan digest`,
    );
    assert.match(
      source,
      /controller-receipt-artifact:/,
      `${workflow} must expose its receipt artifact`,
    );
    assert.match(
      source,
      /controller-receipt-digest:/,
      `${workflow} must expose its receipt digest`,
    );
    assert.match(
      source,
      /controller-receipt-status:/,
      `${workflow} must expose its receipt status`,
    );
    const executedFile = workflow.endsWith("public-release-paper.yml")
      ? ".github/workflows/public-build-publication.yml" : workflow;
    const parsed = readWorkflow(executedFile);
    const graphs = Object.keys(parsed.jobs).map(id => inspectWorkflowJob(executedFile, id));
    const steps = graphs.flatMap(graph => graph.steps);
    const modules = graphs.flatMap(graph => [...graph.modules.values()]).join("\n");
    assert.match(modules, /planControllerEvidence\(/, `${workflow} must create an admitted plan`);
    for (const plan of steps.filter(step => step.uses?.endsWith("/observability/controller/plan"))) {
      for (const key of ["source-sha", "runtime-sha", "contract-digest"]) assert.ok(plan.with[key], key);
      assert.equal(plan.with["input-boundary"], "workflow-call");
    }
    assert.ok(graphs.some(graph => graph.steps.some(step =>
      /(?:receipt|finalize|collect|report)/.test(step.uses || "") &&
      (step.if?.includes("always()") || graph.job.if?.includes("always()")))), `${workflow} must aggregate even after failure`);
    assert.ok(steps.some(step => step.if?.includes("controller-receipt-qualifying != 'true'")) ||
      /if \(!receipt.qualifying\)/.test(modules) || (modules.includes("accepted: captureOnly || receipt.qualifying") && modules.includes("if (!accepted)")), `${workflow} must reject nonqualifying receipts`);
  }

  const gateEnvelope = JSON.stringify(inspectWorkflowJob(".github/workflows/.build-gate-profile.yml", "aggregate").steps);
  assert.match(gateEnvelope, /shifu-gate-aggregate/);
  assert.doesNotMatch(
    gateEnvelope,
    /BUILDCHAIN_CONTROLLER_(?:GATE_IDS|GATE_RESULTS)/,
  );

  const router = readRepoText(".github/workflows/build.yml");
  assert.match(router, /value: \$\{\{ jobs\.build\.outputs\.result \}\}/u);
  assert.match(router, /fromJSON\(jobs\.build\.outputs\.result\)\.artifacts\.controller_receipt\.name/u);
  assert.doesNotMatch(router, /BUILDCHAIN_CONTROLLER_SOURCE_SHA:/u);
});

test("publication artifact workflow exposes paper artifact contract", () => {
  const graph = inspectWorkflowJob(".github/workflows/public-build-publication.yml", "publication");
  const inputs = graph.workflow.on.workflow_call.inputs;
  for (const key of ["runtime-ref", "contract-lock", "toolchain-type", "toolchain-image", "toolchain-digest", "verify-command"])
    assert.ok(inputs[key], key);
  const names = graph.steps.map(step => step.name);
  for (const [before, after] of [
    ["Prepare selected execution runtime", "Qualify reproducible publication and package"],
    ["Qualify reproducible publication and package", "Upload publication artifact"],
  ]) assert.ok(names.indexOf(before) >= 0 && names.indexOf(before) < names.indexOf(after));
  const qualification = graph.modules.get("packages/core/publication/candidate/qualification.js");
  assert.match(qualification, /hydrate[\s\S]*prove[\s\S]*verifyCommand[\s\S]*manifest[\s\S]*bind/);
  const upload = graph.steps.find(step => step.name === "Upload publication artifact");
  assert.equal(upload.with["include-hidden-files"], true);
  assert.equal(upload.with["if-no-files-found"], "error");
  for (const file of ["publication-reproducibility.js", "candidate/manifest.js", "candidate/paper-package.js"])
    assert.ok(graph.modules.has(`packages/core/publication/${file}`));
  const reproducibility = graph.modules.get("packages/core/publication/publication-reproducibility.js");
  assert.match(reproducibility, /"--network=none"/);
  assert.match(reproducibility, /"docker", \["pull", toolchain\.imageRef\]/);
  assert.ok(graph.workflow.on.workflow_call.outputs["publication-registry-path"]);
});

test("paper release workflow publishes declared npm package with source lock and GitHub Release", () => {
  const graph = inspectWorkflowJob(".github/workflows/public-release-paper.yml", "publish");
  const promote = graph.steps.find(step => step.id === "promote");
  assert.equal(promote.with["publish-mode"], "publish-final-version");
  assert.equal(promote.with["publish-auth"], "trusted-publishing");
  assert.equal(promote.with["require-publish-source-lock"], "true");
  for (const [field, target] of [["ref", "gateRef"], ["sha", "sha"], ["locked", "locked"]])
    assert.equal(promote.with[`publish-source-${field}`], "${{ fromJSON(steps.target.outputs.target-json)." + target + " }}");
  assert.equal(promote.with["publish-provider-json"], "${{ steps.target.outputs.provider-json }}");
  assert.match(promote.with["publish-sealed-bundle-manifest"], /sealed-bundle-manifest/);
  assert.match(promote.with["github-release-artifact-paths"], /candidate-json/);
  assert.match(promote.with["release-passport-product-name"], /release-passport-product-name/);
  assert.equal(graph.job.permissions.contents, "read");
  assert.equal(graph.job.permissions["id-token"], "write");
  assert.ok(graph.modules.has("packages/core/paper/publication/candidate.js"));
  assert.ok(graph.modules.has("packages/core/paper/publication/envelope.js"));
  assert.ok(!JSON.stringify(graph.job).match(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets: inherit/));
});

test("artifact relay uploads to S3 and downloads verified GitHub artifact payloads without aws cli", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-artifact-relay-"),
  );
  const fakeS3Root = path.join(workspace, "fake-s3");
  fs.mkdirSync(path.join(workspace, "dist"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".buildchain", "artifacts", "linux-x64"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(workspace, "dist", "package.tgz"), "payload\n");
  fs.writeFileSync(
    path.join(
      workspace,
      ".buildchain",
      "artifacts",
      "linux-x64",
      "manifest.json",
    ),
    "{}\n",
  );
  fs.writeFileSync(
    path.join(
      workspace,
      ".buildchain",
      "artifacts",
      "linux-x64",
      "summary.json",
    ),
    "{}\n",
  );
  fs.writeFileSync(
    path.join(
      workspace,
      ".buildchain",
      "artifacts",
      "linux-x64",
      "diagnostics.json",
    ),
    "{}\n",
  );
  fs.writeFileSync(
    path.join(
      workspace,
      ".buildchain",
      "artifacts",
      "linux-x64",
      "diagnostics-manifest.json",
    ),
    "{}\n",
  );
  fs.writeFileSync(
    path.join(
      workspace,
      ".buildchain",
      "artifacts",
      "linux-x64",
      "events.jsonl",
    ),
    "",
  );

  const oldPath = process.env.PATH;
  const client = createS3ObjectClient({ fakeRoot: fakeS3Root });
  process.env.PATH = "";
  try {
    const { manifest } = await uploadRelayArtifacts({ client,
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

    const download = await downloadRelayArtifacts({ client,
      inputRoot: path.join(workspace, ".buildchain", "artifacts", "linux-x64"),
      outputRoot: path.join(workspace, "relayed"),
      region: "cn-north-1",
      platformId: "linux-x64",
    });
    assert.equal(
      download.objectCount,
      manifest.groups.reduce((sum, group) => sum + group.fileCount, 0),
    );
    assert.equal(
      fs.readFileSync(
        path.join(workspace, "relayed", "payload", "dist", "package.tgz"),
        "utf8",
      ),
      "payload\n",
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          workspace,
          "relayed",
          "manifest",
          ".buildchain",
          "artifacts",
          "linux-x64",
          "manifest.json",
        ),
        "utf8",
      ),
      "{}\n",
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          workspace,
          "relayed",
          "credential-input",
          "dist",
          "package.tgz",
        ),
        "utf8",
      ),
      "payload\n",
    );
    const cleanup = await cleanupRelayArtifacts({ client,
      inputRoot: path.join(workspace, ".buildchain", "artifacts", "linux-x64"),
      region: "cn-north-1",
      platformId: "linux-x64",
    });
    assert.equal(cleanup.objectCount, download.objectCount);
    const remainingObjects = fs
      .readdirSync(path.join(fakeS3Root, "relay-bucket"), { recursive: true })
      .filter((entry) =>
        fs.statSync(path.join(fakeS3Root, "relay-bucket", entry)).isFile(),
      );
    assert.deepEqual(remainingObjects, []);
  } finally {
    process.env.PATH = oldPath;

  }
});

test("release-candidate promotion converges on one canonical v4 publisher", () => {
  const graph = inspectWorkflowJob(".github/workflows/.release-promote.yml", "apply");
  assert.deepEqual(Object.keys(graph.workflow.jobs), ["execution-runtime", "qualify", "apply", "settle"]);
  assert.ok(graph.actions.has("actions/release/promotion/candidate"));
  assert.ok(!graph.actions.has("actions/release/promotion/ref"));
  const publicWorkflow = readWorkflow(".github/workflows/public-release-promote.yml");
  assert.deepEqual(publicWorkflow.jobs.invoke.needs, ["resolve-promotion", "consumer-admission", "execution-runtime"]);
  assert.equal(publicWorkflow.jobs.invoke.uses, "./.github/workflows/.release-promote.yml");
  assert.deepEqual(Object.keys(publicWorkflow.on.workflow_call.inputs).sort(), ["request-json", "runtime-ref", "runtime-selection", "contract-lock"].sort());
});

test("sealed publication authority verifier is independent and credential-free", () => {
  const graph = inspectWorkflowJob(".github/workflows/.release-authority.yml", "verify");
  assert.equal(graph.job.permissions.contents, "read");
  assert.notEqual(graph.job.permissions["id-token"], "write");
  assert.doesNotMatch(JSON.stringify(graph.job), /NODE_AUTH_TOKEN|NPM_TOKEN|BUILDCHAIN_PROMOTION_TOKEN/);
  const names = graph.steps.map(step => step.name);
  const requireBefore = (a, b) => assert.ok(names.indexOf(a) >= 0 && names.indexOf(a) < names.indexOf(b));
  requireBefore("Admit immutable authority request and evidence requirements", "Download exact release-candidate passport evidence");
  requireBefore("Download referenced controller receipt evidence", "Verify sealed admission or retain a non-authorizing dry-run result");
  requireBefore("Checkout exact consumer Gate subject", "Assemble consumer Gate from exact downloaded evidence");
  requireBefore("Checkout exact consumer Gate controller", "Assemble consumer Gate from exact downloaded evidence");
  for (const file of ["admission.js", "consumer-gate.js", "verification.js", "governance.js"])
    assert.ok(graph.modules.has(`packages/core/publication/authority/${file}`));
  const verification = graph.modules.get("packages/core/publication/authority/verification.js");
  assert.match(verification, /verifyPublicationAdmission/);
  assert.doesNotMatch(verification, /verifyCheckout|runtimeSha !==/);
  assert.match(verification, /sourceSha: admission.sourceSha/);
  const verifier = graph.steps.find(step => step.name === "Verify sealed admission or retain a non-authorizing dry-run result");
  for (const key of ["request-json", "admission-bundle-json", "consumer-gate-json", "token"])
    assert.ok(verifier.with[key], key);
  assert.match(verification, /runtimeSha: request.buildchainRef/);
  assert.match(verification, /usedNonces,/);
});

test("self-publication admission assembly binds downloaded evidence without publication credentials", () => {
  const script = ["assembly", "candidate-evidence", "seal", "gate", "runner"].map(name =>
    readRepoText(`packages/core/publication/authority/${name}.js`)).join("\n");
  assert.match(script, /createPublicationArtifactManifestSet/);
  assert.match(script, /createPublicationGateDecision/);
  assert.match(script, /createRunnerProvenance/);
  assert.match(script, /createPublicationAdmission/);
  assert.match(script, /request.publicationVersion/);
  assert.match(script, /admitted source tree does not match release candidate/);
  assert.match(script, /request.autoNoGate !== true/);
  assert.match(script, /managed-release-candidate-no-gate/);
  assert.match(script, /policyDigest: gateBindings\.policyDigest/);
  assert.doesNotMatch(script, /policyDigest: gateAggregate\.policyDigest/);
  assert.match(script, /github-hosted-single-job/);
  assert.doesNotMatch(
    script,
    /NODE_AUTH_TOKEN|NPM_TOKEN|BUILDCHAIN_PROMOTION_TOKEN/,
  );
});

test("publication artifact admission uses validated Gate policy bindings", () => {
  const script = readRepoText(
    "packages/core/publication/authority/seal.js",
  );
  assert.match(script, /policyDigest: gateBindings\.policyDigest/);
  assert.doesNotMatch(script, /policyDigest: gateAggregate\.policyDigest/);
});

test("publication control-plane audit defers npm OIDC authorization to the publish transaction", () => {
  const script = ["collection", "source-authorization", "policy-values", "audit"].map(name => readRepoText(`packages/core/governance/publication/${name}.js`)).join("\n") + readRepoText("packages/core/governance/commands/audit-publication-control-plane.mjs");
  assert.match(script, /provider-at-transaction/);
  assert.match(script, /authorizationDeferred: true/);
  assert.match(script, /configurationRead: false/);
  assert.match(
    script,
    /workflowRef \? `\?ref=\$\{encodeURIComponent\(workflowRef\)\}`/,
  );
  assert.match(script, /evidenceSource: "exact-workflow-source"/);
  assert.match(script, /evidenceSource: "exact-workflow-job"/);
  assert.match(script, /policyMode: "provider-enforced-transaction"/);
  assert.match(script, /source pull-request lineage/);
  assert.match(script, /--allow-release-reconciliation/);
  assert.match(script, /evaluateBuildchainReleaseReconciliation/);
  assert.match(script, /release parent pull-request lineage/);
  assert.match(script, /commits\/\$\{pullRequestHeadSha\}\/check-runs/);
  assert.doesNotMatch(script, /commits\/\$\{sourceSha\}\/check-runs/);
  assert.doesNotMatch(script, /actions\/permissions\/workflow/);
  assert.doesNotMatch(script, /actions\/runners\?per_page/);
  assert.doesNotMatch(script, /\["trust", "list"/);
  assert.match(script, /\^\\s\*\(\?:NODE_AUTH_TOKEN\|NPM_TOKEN\|npm-token/);
  assert.doesNotMatch(script, /= \/NODE_AUTH_TOKEN\|NPM_TOKEN\|npm-token\|/);
});

test("fully retired workflow tombstones are absent", () => {
  const retiredWorkflowNames = [
    ".release-docker.yml",
    ".release-elastic-beanstalk.yml",
    ".release-new-version.yml",
    ".sam-release.yml",
    ".wheel-release.yml",
    "schedule-purge-artifacts.yml",
  ];
  assert.equal(retiredWorkflowNames.length, 6);
  assert.ok(retiredWorkflowNames.every((name) => name.endsWith(".yml")));
  for (const workflowName of retiredWorkflowNames) {
    assert.equal(
      fs.existsSync(path.join(root, ".github/workflows", workflowName)),
      false,
      `${workflowName} must remain deleted`,
    );
  }
});

test("dev PR auto-merge workflow exposes protected dev policy gates", () => {
  const graph = inspectWorkflowJob(".github/workflows/public-ops-dev-auto-merge.yml", "admission");
  const api = graph.workflow.on.workflow_call;
  for (const key of ["target-branch", "expected-pr-number", "expected-head-sha", "diagnostic-context", "required-status-checks", "queue-admission-context", "active-lease-context", "ready-label", "block-labels", "allowed-head-prefixes", "require-approval", "same-repository-only", "max-merges", "landing-mode", "dry-run"])
    assert.ok(api.inputs[key], `Missing delivery policy ${key}`);
  assert.equal(api.inputs["required-status-checks"].default, "check / check");
  assert.equal(api.inputs["landing-mode"].default, "auto");
  assert.equal(api.inputs["dry-run"].default, true);
  for (const key of ["enqueued-count", "action-count", "admission-state", "admission-receipt-root"])
    assert.ok(api.outputs[key]);
  assert.equal(api.inputs["legacy-active-owner-binding-json"], undefined);
  assert.ok(graph.modules.has("packages/core/dev-delivery/candidate/admission.js"));
  assert.ok(graph.modules.has("packages/core/dev-delivery/warrant/reservation-readback.js"));
  assert.match(graph.workflow.concurrency.group, /buildchain-dev-pr-admission-/u);
  const verify = readWorkflow(".github/workflows/self-build-verify.yml");
  assert.ok(Object.hasOwn(verify.on, "pull_request"));
  assert.deepEqual(verify.on.merge_group.types, ["checks_requested"]);
});

test("queued Warrant cancellation workflow binds exact terminal event authority", () => {
  const graph = inspectWorkflowJob(".github/workflows/public-ops-warrant-cancel.yml", "cancel");
  const action = graph.steps.find(step => step.id === "cancel");
  for (const key of ["expected-candidate-id", "expected-source-head-sha", "observed-source-head-sha", "expected-old-state-root", "terminal-evidence-root"])
    assert.ok(graph.workflow.on.workflow_call.inputs[key]);
  assert.equal(action.with["request-json"], "${{ inputs.request-json }}");
  assert.match(action.uses, /warrant\/cancel-queued$/);
  const cancellation = graph.modules.get("packages/core/dev-delivery/warrant/actions.js");
  for (const field of ["expected-old-state-root", "terminal-evidence-root"]) assert.ok(cancellation.includes(field));
  assert.equal((graph.job.permissions || graph.workflow.permissions).contents, "write");
  assert.ok(graph.modules.has("packages/core/dev-delivery/warrant/cancellation.js"));
  assert.ok(graph.steps.some(step => step.uses?.startsWith("actions/upload-artifact@") && step.if.includes("always()")));
});

test("Buildchain self-delivery exposes the complete two-phase Warrant caller", () => {
  const workflow = readWorkflow(".github/workflows/self-ops-dev-delivery.yml"), job = workflow.jobs.deliver;
  assert.deepEqual(workflow.on.repository_dispatch.types, ["buildchain-dev-delivery-wake"]);
  assert.equal(job.uses, "kungfu-systems/buildchain/.github/workflows/public-ops-dev-auto-merge.yml@v4");
  assert.equal(job.with["delivery-warrant-mode"], "required");
  assert.equal(job.with["landing-mode"], "queue");
  assert.equal(job.with["dry-run"], false);
  assert.match(job.with["source-root"], /candidate.sourceRoot.*native-roots-json.*sourceRoot/);
  assert.match(job.with["expected-pr-number"], /candidate.pullRequestNumber.*expected-pr-number/);
  for (const field of ["source-identity-root", "source-patch-root", "plan-root", "closure-root", "dependency-root", "toolchain-root", "environment-root", "native-proof-json", "native-command", "native-heartbeat-seconds"])
    assert.ok(job.with[field], field);
  for (const field of ["assignment-root", "initiative-root", "legacy-active-owner-binding-json"])
    assert.equal(job.with[field], undefined);
  assert.equal(job.with["queue-admission-context"], "Queue admission lease");
  assert.equal(job.with["active-lease-context"], "Queue family lease/exact");
  assert.equal(job.with["required-status-checks"], "check");
  assert.deepEqual(Object.keys(job.secrets), ["github-token"]);
  assert.match(job.secrets["github-token"], /secrets.BUILDCHAIN_PROMOTION_TOKEN/);
  for (const [file, ref] of [["contract-lock.json", "v4"], ["alpha-contract-lock.json", "v4-alpha"]])
    assert.equal(JSON.parse(readRepoText(`.buildchain/${file}`)).buildchain.ref, ref);
});

test("PR-controlled native delivery and provider finalization use distinct hosted jobs", () => {
  const file = ".github/workflows/public-ops-dev-auto-merge.yml";
  const workflow = readWorkflow(file);
  const graphs = Object.fromEntries(Object.keys(workflow.jobs).map(id => [id, inspectWorkflowJob(file, id)]));
  const source = graphs.admission;
  for (const id of ["admission", "native-execution", "seal-native-execution", "delivery-heartbeat", "merge-dev-prs"]) {
    const graph = graphs[id];
    const prepare = graph.job.steps[0];
    assert.equal(prepare.uses, "$/actions/runtime/environment/prepare");
    assert.equal(prepare.with["selection"], "${{ needs.execution-runtime.outputs.selection }}");
    assert.notEqual(graph.job["runs-on"], "self-hosted");
  }
  for (const id of ["native-execution", "seal-native-execution"]) {
    assert.equal(graphs[id].job.permissions.contents, "read");
    for (const step of graphs[id].steps) for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "BUILDCHAIN_PROMOTION_TOKEN"])
      assert.equal(step.env?.[key], undefined, `${id}: ${step.name}`);
  }
  assert.equal(graphs["delivery-heartbeat"].job["runs-on"], "macos-15");
  assert.equal(graphs["delivery-heartbeat"].job.permissions.contents, "write");
  const finalizer = graphs["merge-dev-prs"];
  assert.deepEqual(finalizer.job.needs, ["admission", "native-execution", "seal-native-execution", "delivery-heartbeat", "execution-runtime"]);
  assert.equal(finalizer.job.permissions.contents, "write");
  const boundary = finalizer.steps.findIndex(step => step.name === "Prove fresh provider finalizer job and runner boundary");
  const qualification = finalizer.steps.findIndex(step => step.name === "Verify and qualify transferred native proof");
  assert.ok(boundary >= 0 && qualification > boundary);
  assert.match(finalizer.steps[qualification].if, /steps\.boundary\.outcome == 'success' && steps\.boundary\.outputs\.native-outcome == 'success'/u);
  const transaction = finalizer.modules.get("packages/core/dev-delivery/native/transactions.js");
  const qualified = transaction.slice(transaction.indexOf("export async function qualifyTransferredNative"));
  assert.match(qualified, /verifyNativeProofFile[\s\S]*runTwoPhaseDelivery/);
  for (const module of ["native/qualification.js", "native/provider-boundary.js", "warrant/failure-settlement.js"])
    assert.ok(finalizer.modules.has(`packages/core/dev-delivery/${module}`), module);
  for (const graph of Object.values(graphs)) for (const step of graph.steps) {
    if (step.uses?.startsWith("actions/upload-artifact@") && /^buildchain-dev-delivery-(?:control|native-raw|native-sealed|heartbeat)-/u.test(step.with.name))
      assert.match(step.with.name, /github\.run_id.*github\.run_attempt/u);
  }
  const template = readWorkflow("templates/native-dev-delivery.yml");
  assert.ok(Object.values(template.jobs).some(job => job.uses === "kungfu-systems/buildchain/.github/workflows/public-ops-dev-auto-merge.yml@v4-alpha"));
  assert.equal(template.on.workflow_dispatch.inputs["delivery-class"].default, "native-proof-required");
  assert.ok(template.on.workflow_dispatch.inputs["native-roots-json"]);
});

test("declared merge queue governance reconciles automatically on dev changes", () => {
  const workflow = readRepoText(
    ".github/workflows/self-ops-merge-queue.yml",
  );
  assert.match(workflow, /push:\n\s+branches:\n\s+- dev\/v\*\/v\*/);
  assert.match(workflow, /\.buildchain\/buildchain\.toml/);
  assert.match(
    workflow,
    /BUILDCHAIN_GOVERNANCE_TOKEN \|\| secrets\.BUILDCHAIN_PROMOTION_TOKEN \|\| github\.token/,
  );
  assert.match(inspectWorkflowJob(".github/workflows/self-ops-merge-queue.yml", "reconcile").modules.get("packages/core/dev-delivery/queue/reconciliation-action.js"), /reconcileConfiguredDevMergeQueue\(/);
  assert.match(workflow, /github\.event_name == 'push' \|\| inputs\.apply/);
});

test("patrol workflow family exposes daily weekly monthly reusable entries and dogfood schedules", () => {
  const graph = inspectWorkflowJob(".github/workflows/public-ops-patrol.yml", "patrol");
  const execute = graph.steps.find(step => step.id === "execute");
  assert.match(execute.uses, /governance\/repository\/reconcile-patrol$/);
  assert.equal(execute.with["request-json"], "${{ inputs.request-json }}");
  const action = graph.modules.get("packages/core/governance/patrol/action.js");
  assert.match(action, /cadence: request.cadence/);
  assert.match(action, /dryRun: request\["dry-run"\]/);
  assert.ok(graph.steps.some(step => step.uses?.startsWith("actions/upload-artifact@")));
  for (const cadence of ["daily", "weekly", "monthly"]) {
    const workflow = readWorkflow(`.github/workflows/public-ops-patrol-${cadence}.yml`);
    const caller = readWorkflow(`.github/workflows/self-ops-patrol-${cadence}.yml`);
    const entry = Object.values(workflow.jobs).find(job => job.uses);
    assert.equal(entry.with.cadence, cadence);
    assert.equal(workflow.permissions.contents, "write");
    assert.equal(workflow.permissions["pull-requests"], "write");
    assert.ok(caller.on.schedule.length);
    assert.equal(caller.jobs.patrol.with["runtime-ref"], "${{ inputs.runtime-ref }}");
    assert.ok(Object.values(caller.jobs).some(job => job.uses === `kungfu-systems/buildchain/.github/workflows/public-ops-patrol-${cadence}.yml@v4`));
  }
});

test("stable candidate patrol persists exact candidates and uses source-lock PR promotion", () => {
  assert.equal(readWorkflow(".github/workflows/self-ops-stable-candidate-patrol.yml").jobs.patrol.with["runtime-ref"], "${{ inputs.runtime-ref }}");
  const graph = inspectWorkflowJob(".github/workflows/public-ops-stable-candidate-patrol.yml", "patrol");
  assert.equal(graph.workflow.concurrency["cancel-in-progress"], false);
  for (const field of ["release-now", "auto-promote", "auto-merge"])
    assert.ok(graph.workflow.on.workflow_call.inputs[field]);
  assert.ok(graph.modules.has("packages/core/release/stable-patrol/controller.js"));
  assert.ok(graph.modules.has("packages/core/release/stable-patrol/options.js"));
  const approval = graph.steps.find(step => step.with?.["approval-token"]);
  assert.match(approval.with["approval-token"], /inputs.secrets-approval-token \|\| github.token/);
  const qualification = readWorkflow(".github/workflows/self-build-stable-candidate-qualification.yml");
  assert.deepEqual(qualification.on.workflow_run.workflows, ["Buildchain Alpha Self-Dogfood"]);
  const qualified = inspectWorkflowJob(".github/workflows/self-build-stable-candidate-qualification.yml", "qualify");
  assert.ok(qualified.modules.has("packages/core/release/qualification/public-build.js"));
  assert.doesNotMatch(JSON.stringify(qualified.steps), /secrets\.|canary-ref|candidate-sha/);
  assert.ok(qualified.steps.some(step => step.uses?.startsWith("actions/download-artifact@") && step.with["run-id"]));
});

test("check workflow exposes source and verify modes through the declared nodes", () => {
  const workflow = readRepoText(".github/workflows/public-build-check.yml");
  const node = readRepoText("actions/build/source/qualify/action.yml");
  const proof = readRepoText("actions/build/source/proof/action.yml");
  const execution = readRepoText("actions/build/source/check-lifecycle/action.yml");
  const verify = readRepoText("actions/build/verification/repository/action.yml");
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /mode:/);
  assert.match(workflow, /default: "?verify"?/);
  assert.match(workflow, /inputs\.mode == 'source' && inputs\.source-proof-reuse/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha \|\| github\.sha/);
  assert.match(workflow, /runtime-ref: \$\{\{ inputs\.runtime-ref \}\}/);
  assert.match(node, /actions\/build\/source\/proof/);
  assert.match(node, /actions\/build\/source\/check-lifecycle/);
  assert.match(node, /steps.source-proof.outputs.verify-reuse != 'true'/);
  assert.match(proof, /steps.source-proof-download.outcome == 'success'/);
  assert.match(execution, /actions\/build\/source\/run-check/);
  const lifecycle = readRepoText("packages/core/build/source/lifecycle.js");
  assert.match(lifecycle, /\["install", "install", "-install"\][\s\S]*\["check", stage, ""\]/);
  assert.match(lifecycle, /stageName,[\s\S]*required: true/);
  assert.match(node, /retention-days: 14/);
  assert.match(verify, /actions\/build\/verification\/qualify-source/);
  const qualification = readRepoText("packages/core/build/verification/source.js");
  assert.match(qualification, /qualify = qualifySourceLifecycle/);
  assert.match(qualification, /mode: "verify"/);
  assert.doesNotMatch(workflow + node + proof + execution, /\|\| 'v3'/);
});

test("source-check fixture executes only install and check", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-source-check-"),
  );
  fs.cpSync(path.join(root, "fixtures/source-check-shaped"), workspace, {
    recursive: true,
  });

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

    const events = fs
      .readFileSync(
        path.join(workspace, ".buildchain/source-check-events.txt"),
        "utf8",
      )
      .trim()
      .split("\n");
    assert.deepEqual(events, ["install:source", "check:source"]);
    assert.ok(!events.some((event) => event.startsWith("build:")));
    assert.ok(!events.some((event) => event.startsWith("verify:")));
  } finally {
    if (previousMode === undefined) delete process.env.BUILDCHAIN_CHECK_MODE;
    else process.env.BUILDCHAIN_CHECK_MODE = previousMode;
  }
});

test("reusable web-surface workflow exposes preview, cleanup, staging, and production gates", () => {
  const file = ".github/workflows/public-release-web.yml", workflow = readWorkflow(file);
  assert.equal(workflow.on.workflow_call.inputs["buildchain-contract-compatibility-policy"], undefined);
  assert.ok(workflow.on.workflow_call.inputs["contract-lock"]);
  const plan = inspectWorkflowJob(file, "plan"), names = plan.steps.map(step => step.name);
  assert.ok(workflow.jobs.plan.needs.includes("apply-input-gate"));
  assert.ok(names.indexOf("Prepare selected execution runtime") >= 0 && names.indexOf("Prepare selected execution runtime") < names.indexOf("Build and plan the admitted channel"));
  assert.ok(plan.actions.has("actions/web/planning/build"));
  for (const id of ["preview-apply", "preview-cleanup", "staging-apply", "production-apply"]) {
    const graph = inspectWorkflowJob(file, id);
    assert.equal(graph.job.permissions["id-token"], "write");
    assert.ok(graph.steps.some(step => step.uses?.startsWith("aws-actions/configure-aws-credentials@")));
    if (id !== "preview-cleanup") assert.ok(graph.steps.some(step => step.uses?.startsWith("actions/upload-artifact@")));
  }
  assert.equal(workflow.jobs["production-apply"].environment, "${{ inputs.production-environment }}");
  assert.equal(workflow.jobs["external-publication-authority"].uses, "./.github/workflows/.release-authority.yml");
  assert.ok(workflow.jobs["open-production-release-pr"].needs.includes("staging-apply"));
});

test("web-surface side-effect jobs and sealed production paths have explicit authority", () => {
  const file = ".github/workflows/public-release-web.yml";
  const plan = inspectWorkflowJob(file, "plan");
  assert.equal(plan.job.permissions["pull-requests"], "write");
  assert.equal(plan.job.permissions.issues, "write");
  assert.ok(plan.modules.has("packages/core/web/release-review.js"));
  const decision = inspectWorkflowJob(file, "publication-decision");
  assert.ok(decision.modules.has("packages/core/web/production-decision.js"));
  const authority = inspectWorkflowJob(file, "publication-authority");
  assert.match(authority.job.if, /needs.publication-decision.outputs.approved == 'true'/);
  assert.ok(authority.steps.some(step => step.name === "Seal Web publication admission"));
  const production = inspectWorkflowJob(file, "production-apply");
  assert.match(production.job.if, /needs.publication-authority.result == 'success'/);
  assert.match(production.job.if, /needs.external-publication-authority.result == 'success'/);
  const names = production.steps.map(step => step.name);
  assert.ok(names.indexOf("Verify sealed capability before artifact download") >= 0);
  assert.ok(names.indexOf("Verify sealed capability before artifact download") < names.indexOf("Download web-surface artifact"));
  assert.ok(names.indexOf("Download web-surface artifact") < names.indexOf("Configure production AWS credentials"));
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
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-release-pr-summary-"),
  );
  const summaryPath = path.join(
    dir,
    "web-surface-staging-release-pr-summary.json",
  );
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
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify(compactProductionReleasePrSummary(fullApplyResult), null, 2)}\n`,
  );
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
  assert.equal(
    handoff.contract,
    "kungfu-buildchain-web-surface-production-release-pr-handoff",
  );
  assert.equal(handoff.branchName, "release/production-abcdef123456");
  assert.equal(handoff.title, "Release production from abcdef123456");
  assert.match(
    handoff.manualCommand,
    /gh pr create --repo kungfu-systems\/site-libkungfu-dev/,
  );
  assert.match(
    handoff.manualCommand,
    /--body-file \.buildchain\/production-release-pr\/body\.md/,
  );
});

test("web-surface production release PR suppresses a duplicate for a merged release push", async () => {
  const previousFetch = globalThis.fetch;
  const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url).includes(`/commits/${sourceSha}/pulls?`)) {
      return new Response(
        JSON.stringify([
          {
            number: 42,
            html_url:
              "https://github.com/kungfu-systems/site-libkungfu-dev/pull/42",
            merged_at: "2026-07-26T00:00:00Z",
            base: { ref: "main" },
            head: {
              ref: "release/production-abcdef123456",
              repo: { full_name: "kungfu-systems/site-libkungfu-dev" },
            },
            labels: [{ name: "buildchain-release" }],
          },
        ]),
        { status: 200 },
      );
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
    assert.equal(
      calls.some((call) => call.method === "POST"),
      false,
    );
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
      return new Response(
        JSON.stringify([
          {
            number: 41,
            merged_at: "2026-07-25T23:59:00Z",
            base: { ref: "main" },
            head: {
              ref: "fix/preceding-source-change",
              repo: { full_name: "kungfu-systems/site-libkungfu-dev" },
            },
            labels: [],
          },
        ]),
        { status: 200 },
      );
    }
    if (
      String(url).includes(
        "/pulls?state=closed&base=main&head=kungfu-systems%3Arelease%2Fproduction-abcdef123456",
      )
    ) {
      return new Response(
        JSON.stringify([
          {
            number: 42,
            html_url:
              "https://github.com/kungfu-systems/site-libkungfu-dev/pull/42",
            merged_at: "2026-07-26T00:00:00Z",
            base: { ref: "main" },
            head: {
              ref: "release/production-abcdef123456",
              repo: { full_name: "kungfu-systems/site-libkungfu-dev" },
            },
            labels: [{ name: "buildchain-release" }],
          },
        ]),
        { status: 200 },
      );
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
    assert.equal(
      calls.every((call) => call.method === "GET"),
      true,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("web-surface release-intent suppression records a durable control-plane outcome", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-release-pr-suppression-event-"),
  );
  const logPath = path.join(workspace, ".buildchain", "logs", "events.jsonl");
  recordProductionReleasePrOutcome(
    {
      action: "suppressed-merged-release-pr",
      status: "suppressed-merged-release-pr",
      suppressionReason:
        "source-commit-already-has-qualifying-merged-release-pr",
      repository: "kungfu-systems/site-libkungfu-dev",
      productionReleaseChannel: "production",
      pullNumber: 42,
      sourceSha: "abcdef1234567890abcdef1234567890abcdef12",
    },
    { logPath },
  );

  const event = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
  assert.equal(event.event, "control-plane.release-intent.outcome");
  assert.equal(event.attributes.outcome, "suppressed");
  assert.equal(
    event.attributes.reason,
    "source-commit-already-has-qualifying-merged-release-pr",
  );
});

test("web-surface production release PR permission-denied is a non-fatal handoff", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-release-pr-permission-"),
  );
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
    if (String(url).includes(`/commits/${sourceSha}/pulls?`))
      return new Response("[]", { status: 200 });
    if (String(url).includes("/pulls?state=closed"))
      return new Response("[]", { status: 200 });
    if (String(url).includes("/pulls?state=open"))
      return new Response("[]", { status: 200 });
    if (String(url).endsWith(`/git/commits/${sourceSha}`)) {
      return new Response(JSON.stringify({ tree: { sha: "tree-sha" } }), {
        status: 200,
      });
    }
    if (String(url).endsWith("/git/commits") && options.method === "POST") {
      return new Response(JSON.stringify({ sha: "release-intent-sha" }), {
        status: 201,
      });
    }
    if (String(url).endsWith("/git/refs") && options.method === "POST") {
      return new Response(
        JSON.stringify({ ref: "refs/heads/release/production-abcdef123456" }),
        { status: 201 },
      );
    }
    if (String(url).endsWith("/pulls") && options.method === "POST") {
      return new Response(
        JSON.stringify({
          message:
            "GitHub Actions is not permitted to create or approve pull requests.",
        }),
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
      PRODUCTION_RELEASE_PR_SUMMARY_PATH:
        ".buildchain/production-release-pr/handoff.json",
      PRODUCTION_RELEASE_PR_BODY_PATH:
        ".buildchain/production-release-pr/body.md",
      BUILDCHAIN_LOG_PATH: logPath,
    });
    assert.equal(result.status, "permission-denied");
    assert.match(
      fs.readFileSync(outputPath, "utf8"),
      /release-pr-status=permission-denied/,
    );
    assert.match(
      fs.readFileSync(outputPath, "utf8"),
      /production-release-token-source=github-token/,
    );
    assert.match(
      fs.readFileSync(stepSummaryPath, "utf8"),
      /Manual PR creation command/,
    );
    const handoff = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/production-release-pr/handoff.json"),
        "utf8",
      ),
    );
    assert.equal(handoff.status, "permission-denied");
    assert.equal(handoff.error.status, 403);
    assert.equal(handoff.tokenSource, "github-token");
    const event = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(event.event, "control-plane.release-intent.outcome");
    assert.equal(event.attributes.outcome, "failed");
    assert.equal(event.attributes.action, "permission-denied");
    assert.ok(
      calls.some(
        (call) => call.method === "POST" && call.url.endsWith("/pulls"),
      ),
    );
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = previousFetch;
  }
});

test("web-surface production release PR reports unavailable app token before fallback github token", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-release-pr-app-token-unavailable-"),
  );
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
      PRODUCTION_RELEASE_PR_SUMMARY_PATH:
        ".buildchain/production-release-pr/handoff.json",
      PRODUCTION_RELEASE_PR_BODY_PATH:
        ".buildchain/production-release-pr/body.md",
    });
    assert.equal(result.status, "app-token-unavailable");
    assert.equal(called, false);
    assert.match(
      fs.readFileSync(outputPath, "utf8"),
      /release-pr-status=app-token-unavailable/,
    );
    assert.match(
      fs.readFileSync(outputPath, "utf8"),
      /production-release-app-token-status=missing-private-key/,
    );
    assert.match(
      fs.readFileSync(stepSummaryPath, "utf8"),
      /app token status: `missing-private-key`/,
    );
    const handoff = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/production-release-pr/handoff.json"),
        "utf8",
      ),
    );
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
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-release-pr-summary-only-"),
  );
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
      PRODUCTION_RELEASE_PR_SUMMARY_PATH:
        ".buildchain/production-release-pr/handoff.json",
      PRODUCTION_RELEASE_PR_BODY_PATH:
        ".buildchain/production-release-pr/body.md",
    });
    assert.equal(result.status, "summary-only");
    assert.equal(called, false);
    assert.equal(
      fs.existsSync(
        path.join(workspace, ".buildchain/production-release-pr/handoff.json"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(workspace, ".buildchain/production-release-pr/body.md"),
      ),
      true,
    );
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
    productionReleaseOnMain: true,
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
      productionReleaseOnMain: true,
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
    runUrl:
      "https://github.com/kungfu-systems/site-kungfu-tech/actions/runs/123",
    runtimeSha: "b".repeat(40),
    payload: { head_commit: { timestamp: "2026-07-04T00:00:00Z" } },
    sourceEvent: "push",
    target: {
      pullNumber: 42,
      sourceBranch: "feature/release-site",
      source: "release-intent",
    },
    gate: { label: "buildchain-release", headPrefix: "feature/release-" },
    privacyMode: "private-ref",
    actor: "keren",
    runnerActor: "GitHub Actions",
    oidcDeployIdentity:
      "arn:aws:iam::123456789012:role/site-production-github-actions",
  });

  assert.equal(passport.responsibility.pullRequest, 42);
  assert.equal(passport.responsibility.sourceEvent, "push");
  assert.equal(
    passport.responsibility.requiredGateEvidence.label,
    "buildchain-release",
  );
  assert.match(
    passport.responsibility.humanDecisionActor,
    /^private-ref:sha256:/,
  );
  assert.equal(
    normalizeActorIdentity("keren", {
      privacyMode: "redacted",
      kind: "human-decision-actor",
    }),
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

test("binary distribution exposes only current evidence production", () => {
  const workflow = readRepoText(".github/workflows/self-build-binary-distribution.yml");
  const preflight = readRepoText("actions/build/binary/preflight/action.yml");
  assert.deepEqual(readWorkflow(".github/workflows/self-build-binary-distribution.yml").jobs.binary.needs, ["preflight", "execution-runtime"]);
  assert.equal(readWorkflow("actions/build/binary/preflight/action.yml").runs.using, "node24");
  assert.match(readRepoText("packages/core/build/binary/actions.js"), /admitBinaryDistributionAction/);
  assert.doesNotMatch(workflow, /upload-release/);
  assert.match(workflow, /actions\/build\/binary\/passport/);
});

test("binary evidence publication remains isolated from the canonical v4 publisher", () => {
  const evidence = readRepoText(".github/workflows/self-build-binary-distribution.yml");
  const publication = readRepoText(".github/workflows/.release-binary-assets.yml");
  const publicPublication = readRepoText(
    ".github/workflows/self-release-binary-assets.yml",
  );
  const promotion = readRepoText(
    ".github/workflows/.release-promote.yml",
  );
  assert.doesNotMatch(evidence, /gh release create|gh release upload/);
  assert.match(evidence, /Dispatch sealed binary asset publication/);
  assert.match(publication, /environment: buildchain-release-assets/);
  assert.match(publication, /actions\/release\/binary\/publish/);
  assert.match(readRepoText("actions/release/binary/publish/action.yml"), /actions\/publication\/binary\/publish/);
  assert.match(
    publicPublication,
    /uses: \.\/\.github\/workflows\/\.release-binary-assets\.yml/,
  );
  assert.doesNotMatch(
    promotion,
    /Dispatch standalone binary distribution|gh workflow run binary-distribution\.yml/,
  );
});
test("canonical v4 alpha publication does not retain a binary or stable publisher", () => {
  const promotion = readRepoText(
    ".github/workflows/.release-promote.yml",
  );
  const selfPromotion = readRepoText(
    ".github/workflows/self-release-promote.yml",
  );
  const recovery = readRepoText(
    ".github/workflows/self-ops-promotion-recovery.yml",
  );
  assert.match(promotion, /^  apply:/m);
  assert.doesNotMatch(promotion, /gh workflow run binary-distribution\.yml/);
  assert.match(selfPromotion, /^  promote:/m);
  assert.doesNotMatch(selfPromotion, /^  promote-stable:/m);
  assert.match(
    recovery,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/public-release-promote\.yml@v4/,
  );
});

test("web-surface release PR close hands production to the protected main push", () => {
  assert.equal(admitWebApplyInputs({ event: {name: "pull_request", action: "closed"}, decisionApproved: false })["web-surface-channel"], "");
  assert.equal(admitWebApplyInputs({ event: {name: "push", refName: "main"}, decisionApproved: true })["web-surface-channel"], "production");
  assert.match(readRepoText("packages/core/web/production-decision.js"), /release-pr-verified-awaiting-main-push/);
});


test("alpha patrol has one explicit settlement authorization input", () => {
  const workflow = readWorkflow(".github/workflows/public-ops-alpha-candidate-patrol.yml");
  assert.equal(workflow.on.workflow_call.inputs["create-pull-request"], undefined);
  assert.ok(workflow.on.workflow_call.inputs["settlement-authorized"]);
  assert.match(workflow.jobs.settle.if, /inputs\.settlement-authorized/u);
  assert.doesNotMatch(workflow.jobs.settle.if, /create-pull-request/u);
});
