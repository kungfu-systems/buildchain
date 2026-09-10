import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectWorkflowJob, readWorkflow } from "../scripts/workflow-action-graph.mjs";
import {
  createBuildchainContractLock,
  createBuildchainContractWorld,
} from "../packages/core/contracts/buildchain-contract.js";
import { initBuildchainRepo } from "../packages/core/adoption/commands/init-repo.mjs";
import {
  assertPromotionCertificationWiring,
  assertTrustGatedJobs,
  checkFloatingConsumerPolicyContract,
  workflowJobBlock,
} from "../scripts/check-floating-consumer-policy-contract.mjs";
import {
  resolveFloatingConsumerPolicyAuthority,
  scanFloatingConsumerPolicy,
} from "../packages/core/consumer/floating-consumer-policy.js";
import { scanRuntimeSelectorPersistence } from "../packages/core/consumer/runtime-selector-persistence.js";

const root = path.resolve(import.meta.dirname, "..");

test("v4 floating policy contract check accepts the repository wiring", () => {
  assert.equal(checkFloatingConsumerPolicyContract().ok, true);
});

test("public adopter delivery uploads the exact receipt returned by its admission node", () => {
  const file = ".github/workflows/public-build-adopter-qualification.yml";
  const workflow = readWorkflow(file);
  const graphs = Object.keys(workflow.jobs).map(id => inspectWorkflowJob(file, id));
  const graph = graphs.find(item => item.actions.has("actions/adoption/adopter/admit"));
  assert.ok(graph);
  const upload = graph.steps.find(step => step.name === "Preserve rooted policy");
  assert.equal(upload.with.path, "${{ steps.policy.outputs.v4-consumer-policy-receipt-path }}");
  assert.equal(upload.with["include-hidden-files"], true);
  assert.equal(upload.with["if-no-files-found"], "error");
  const checkout = graph.steps.find(step => step.name === "Check out admitted consumer");
  assert.equal(checkout.with.repository, "${{ steps.selection.outputs.repository }}");
  assert.equal(checkout.with.ref, "${{ steps.selection.outputs.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
});

function writeCurrentRuntimeLocks(consumerRoot) {
  fs.mkdirSync(path.join(consumerRoot, ".buildchain"), { recursive: true });
  const contractWorld = createBuildchainContractWorld({ root });
  for (const [ref, file] of [
    ["v4", "contract-lock.json"],
    ["v4-alpha", "alpha-contract-lock.json"],
  ]) {
    fs.writeFileSync(
      path.join(consumerRoot, ".buildchain", file),
      JSON.stringify(
        createBuildchainContractLock({
          buildchainRef: ref,
          resolvedSha: "b".repeat(40),
          contractWorld,
        }),
      ),
    );
  }
}

test("alpha promotion wiring admits a consumer that accepted the selected runtime", (t) => {
  const consumerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-promotion-wiring-"),
  );
  t.after(() => fs.rmSync(consumerRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(consumerRoot, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(consumerRoot, ".github/workflows/release.yml"), "jobs:\n  promote:\n    uses: kungfu-systems/buildchain/.github/workflows/public-release-promote.yml@v4-alpha\n");
  writeCurrentRuntimeLocks(consumerRoot);
  const authority = resolveFloatingConsumerPolicyAuthority({
    runtimeRoot: root,
    callerRoot: consumerRoot,
  });
  const result = scanFloatingConsumerPolicy({
    root: consumerRoot,
    repository: "kungfu-systems/example",
    sourceSha: "a".repeat(40),
    invokedWorkflow: ".github/workflows/public-release-promote.yml",
    invocationSourcePath: ".github/workflows/release.yml",
    expectedInvocationChannel: "alpha",
    resolvedWorkflowSha: "b".repeat(40),
    resolvedRuntimeSha: "b".repeat(40),
    policy: authority.policy,
    scannerRoot: authority.scannerRoot,
  });

  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.receipt.invocation.visibleSelector, "v4-alpha");
  assert.equal(result.receipt.invocation.selectorClass, "floating");
  assert.equal(result.receipt.invocation.channel, "alpha");
});

test("bounded recovery is a one-way adapter into the same public publisher", () => {
  const relative = ".github/workflows/self-ops-promotion-recovery.yml";
  const workflow = fs.readFileSync(path.join(root, relative), "utf8");
  const publicPromotion = fs.readFileSync(
    path.join(root, ".github/workflows/public-release-promote.yml"),
    "utf8",
  );
  const authority = resolveFloatingConsumerPolicyAuthority({
    runtimeRoot: root,
    callerRoot: root,
  });
  const consumerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-recovery-consumer-"),
  );
  const invocationRoot = path.join(consumerRoot, "invocation-source");
  fs.mkdirSync(path.join(consumerRoot, ".buildchain"), { recursive: true });
  fs.mkdirSync(path.join(invocationRoot, ".github", "workflows"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(
      invocationRoot,
      ".github",
      "workflows",
      "public-release-promote.yml",
    ),
    [
      "jobs:",
      "  alpha:",
      "    uses: kungfu-systems/buildchain/.github/workflows/.release-promote.yml@v4-alpha",
      "  stable:",
      "    uses: kungfu-systems/buildchain/.github/workflows/.release-promote.yml@v4",
      "",
    ].join("\n"),
  );
  writeCurrentRuntimeLocks(consumerRoot);
  try {
    const result = scanFloatingConsumerPolicy({
      root: consumerRoot,
      invocationRoot,
      repository: "kungfu-systems/buildchain",
      sourceSha: "a".repeat(40),
      invokedWorkflow: ".github/workflows/.release-promote.yml",
      invocationSourcePath: ".github/workflows/public-release-promote.yml",
      expectedInvocationChannel: "stable",
      resolvedWorkflowSha: "b".repeat(40),
      resolvedRuntimeSha: "c".repeat(40),
      policy: authority.policy,
      scannerRoot: authority.scannerRoot,
    });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.receipt.invocation.visibleSelector, "v4");
    assert.equal(result.receipt.invocation.selectorClass, "floating");
    assert.equal(result.receipt.invocation.channel, "stable");
  } finally {
    fs.rmSync(consumerRoot, { recursive: true, force: true });
  }
  assert.match(workflow, /^  workflow_dispatch:/mu);
  assert.equal(readWorkflow(relative).jobs.resume.uses, "./.github/workflows/public-release-promote.yml");
  assert.equal(readWorkflow(".github/workflows/public-release-promote.yml").jobs.invoke.uses, "./.github/workflows/.release-promote.yml");
  assert.doesNotMatch(workflow, /^  consumer-admission:/mu);
  for (const marker of ["resume-candidate-run-id", "resume-buildchain-runtime-sha", "resume-transaction-id"]) {
    assert.ok(readWorkflow(relative).jobs.resume.with["request-json"].includes(`"${marker}":`));
  }
  assert.match(workflow, /"publish-transaction-override": true/);
});

test("v4 floating policy contract rejects certification without caller lock readback", () => {
  assert.throws(
    () =>
      assertPromotionCertificationWiring(
        'node "${policy_runtime}/packages/core/consumer/commands/consumer-policy.mjs" certify',
      ),
    /promotion certification is missing/u,
  );
});

test("fresh promotion binds exact publisher and runtime identities through QUALIFY", () => {
  const graph = inspectWorkflowJob(".github/workflows/.release-promote.yml", "qualify");
  const node = graph.job.steps.find(step => step.id === "node");
  assert.equal(node.with["job-workflow-sha"], "${{ toJSON(job.workflow_sha) }}");
  const qualification = graph.modules.get("packages/core/release/promotion/qualification-action.js");
  assert.match(qualification, /verifyCheckoutIdentity\([\s\S]*sha: runtimeSha/);
  assert.match(qualification, /"publisher-sha": workflowSha/);
  assert.match(qualification, /"runtime-tree": tree/);
  const candidate = graph.modules.get("packages/core/release/promotion/candidate.js");
  assert.match(candidate, /authorizationJson: request\["promotion-runtime-authorization-json"\]/);
  assert.match(candidate, /authorizationRoot: request\["promotion-runtime-authorization-root"\]/);
});

test("v4 floating policy contract rejects an unbound publisher identity", () => {
  const workflow = fs
    .readFileSync(
      path.join(root, ".github/workflows/.release-promote.yml"),
      "utf8",
    )
    .replace(/^\s*job-workflow-sha:.*$/mu, "");
  assert.throws(
    () => assertPromotionCertificationWiring(workflow),
    /promotion certification is missing/u,
  );
});

test("v4 floating policy contract check rejects a heavy job without plan", () => {
  const source = `jobs:\n  resolve-source:\n    needs:\n      - plan\n  build-native:\n    needs:\n      - resolve-source\n`;
  assert.match(workflowJobBlock(source, "build-native"), /resolve-source/u);
  assert.throws(
    () => assertTrustGatedJobs(source, ["resolve-source", "build-native"]),
    /build-native is not directly gated by plan/u,
  );
});

test("generated consumer workflow persists v4 and declares both contract locks", () => {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-policy-template-"),
  );
  try {
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      '{"name":"fixture","version":"1.0.0"}\n',
    );
    initBuildchainRepo({ cwd, type: "package", packageManager: "npm" });
    const workflow = fs.readFileSync(
      path.join(cwd, ".github/workflows/build.yml"),
      "utf8",
    );
    assert.match(workflow, /@v4/u);
    assert.match(workflow, /\.buildchain\/contract-lock\.json/u);
    assert.match(workflow, /\.buildchain\/alpha-contract-lock\.json/u);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
