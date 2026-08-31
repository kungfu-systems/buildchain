import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initBuildchainRepo } from "../scripts/init-repo.mjs";
import {
  assertPromotionCertificationWiring,
  assertTrustGatedJobs,
  checkV4FloatingConsumerPolicyContract,
  workflowJobBlock,
} from "../scripts/check-v4-floating-consumer-policy-contract.mjs";
import {
  resolveV4FloatingConsumerPolicyAuthority,
  scanV4FloatingConsumerPolicy,
} from "../packages/core/v4-floating-consumer-policy.js";
import { scanV4RuntimeSelectorPersistence } from "../packages/core/v4-runtime-selector-persistence.js";

const root = path.resolve(import.meta.dirname, "..");

test("v4 floating policy contract check accepts the repository wiring", () => {
  assert.equal(checkV4FloatingConsumerPolicyContract().ok, true);
});

test("public adopter delivery uploads the receipt resolved under the consumer root", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/v4-adopter-delivery.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /path: \$\{\{ steps\.policy\.outputs\.v4-consumer-policy-receipt-path \}\}/u,
  );
  assert.match(
    workflow,
    /path: \$\{\{ steps\.policy\.outputs\.v4-consumer-policy-receipt-path \}\}\n\s+include-hidden-files: true\n\s+if-no-files-found: error/u,
  );
  assert.doesNotMatch(
    workflow,
    /path: \.buildchain\/evidence\/v4-adopter-delivery-policy-receipt\.json/u,
  );
  assert.match(
    workflow,
    /BUILDCHAIN_INVOCATION_SOURCE_PATH: \$\{\{ inputs\['invocation-source-path'\] \|\| \(github\.repository == 'kungfu-systems\/buildchain' && '\.github\/workflows\/v4-adopter-delivery-dogfood\.yml' \|\| ''\) \}\}/u,
  );
  assert.match(
    workflow,
    /--repository "\$\{\{ inputs\['consumer-repository'\] \|\| github\.repository \}\}"\n\s+--source-sha "\$\{\{ steps\.consumer-source\.outputs\.sha \}\}"/u,
  );
  assert.doesNotMatch(workflow, /github\.event_name == 'workflow_dispatch'/u);
});

test("alpha promotion caller passes the same runtime admission used in GitHub", () => {
  const authority = resolveV4FloatingConsumerPolicyAuthority({
    runtimeRoot: root,
    callerRoot: root,
  });
  const result = scanV4FloatingConsumerPolicy({
    root,
    repository: "kungfu-systems/buildchain",
    sourceSha: "a".repeat(40),
    invokedWorkflow: ".github/workflows/release-candidate-promote.yml",
    invocationSourcePath: ".github/workflows/buildchain-ref-promotion.yml",
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
  const relative = ".github/workflows/buildchain-ref-promotion-recovery.yml";
  const workflow = fs.readFileSync(path.join(root, relative), "utf8");
  const publicPromotion = fs.readFileSync(
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
    "utf8",
  );
  const authority = resolveV4FloatingConsumerPolicyAuthority({
    runtimeRoot: root,
    callerRoot: root,
  });
  const consumerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-recovery-consumer-"),
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
      "release-candidate-promote.yml",
    ),
    [
      "jobs:",
      "  alpha:",
      "    uses: kungfu-systems/buildchain/.github/workflows/.release-candidate-promote.yml@v4-alpha",
      "  stable:",
      "    uses: kungfu-systems/buildchain/.github/workflows/.release-candidate-promote.yml@v4",
      "",
    ].join("\n"),
  );
  for (const lock of ["contract-lock.json", "alpha-contract-lock.json"])
    fs.copyFileSync(
      path.join(root, ".buildchain", lock),
      path.join(consumerRoot, ".buildchain", lock),
    );
  try {
    const result = scanV4FloatingConsumerPolicy({
      root: consumerRoot,
      invocationRoot,
      repository: "kungfu-systems/buildchain",
      sourceSha: "a".repeat(40),
      invokedWorkflow: ".github/workflows/.release-candidate-promote.yml",
      invocationSourcePath: ".github/workflows/release-candidate-promote.yml",
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
  assert.match(
    workflow,
    /^  resume:[\s\S]*release-candidate-promote\.yml@v4-alpha/mu,
  );
  assert.ok(
    publicPromotion.includes(
      "BUILDCHAIN_INVOCATION_SOURCE_PATH: ${{ inputs.publication-publisher-workflow-path == '.github/workflows/buildchain-ref-promotion-recovery.yml' && '.github/workflows/release-candidate-promote.yml' || inputs.publication-publisher-workflow-path }}",
    ),
  );
  assert.ok(
    publicPromotion.includes(
      "BUILDCHAIN_INVOKED_WORKFLOW: ${{ inputs.publication-publisher-workflow-path == '.github/workflows/buildchain-ref-promotion-recovery.yml' && '.github/workflows/.release-candidate-promote.yml' || '.github/workflows/release-candidate-promote.yml' }}",
    ),
  );
  assert.doesNotMatch(workflow, /^  consumer-admission:/mu);
  assert.doesNotMatch(workflow, /uses:.*@alpha\/v4\/v4\.0/u);
  for (const marker of [
    "resume-candidate-run-id: ${{ inputs['resume-candidate-run-id'] }}",
    "resume-buildchain-runtime-sha: ${{ inputs['resume-buildchain-runtime-sha'] }}",
    "resume-transaction-id: ${{ inputs['resume-transaction-id'] }}",
    "publish-transaction-override: true",
  ])
    assert.match(
      workflow,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
});

test("v4 floating policy contract rejects certification without caller lock readback", () => {
  assert.throws(
    () =>
      assertPromotionCertificationWiring(
        'node "${policy_runtime}/scripts/v4-consumer-policy.mjs" certify',
      ),
    /promotion certification is missing/u,
  );
});

test("fresh promotion roots policy, candidate, publisher, and runtime before APPLY", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  assert.match(workflow, /QUALIFY canonical v4 release invocation inputs/u);
  assert.match(workflow, /publisher-sha=\$\{\{ job\.workflow_sha \}\}/u);
  assert.match(
    workflow,
    /tree="\$\(git -C \.buildchain\/runtime rev-parse 'HEAD\^\{tree\}'\)"/u,
  );
  assert.match(workflow, /Translate and admit legacy-compatible inputs/u);
  assert.match(workflow, /Resolve and qualify the sealed release candidate/u);
  assert.match(workflow, /APPLY one rooted provider transaction/u);
  assert.match(
    workflow,
    /runtime-commit: \$\{\{ needs\.qualify\.outputs\.runtime-sha \}\}/u,
  );
  assert.match(
    workflow,
    /runtime-tree: \$\{\{ needs\.qualify\.outputs\.runtime-tree \}\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /policy_runtime=\.buildchain\/runtime\/promotion-shell/u,
  );
  assert.doesNotMatch(
    workflow,
    /BUILDCHAIN_EXPECTED_RUNTIME_SHA: \$\{\{ inputs\.resume-expected-candidate-runtime-sha/u,
  );
});

test("v4 floating policy contract rejects an unbound certification root", () => {
  const workflow = fs
    .readFileSync(
      path.join(root, ".github/workflows/.release-candidate-promote.yml"),
      "utf8",
    )
    .replace(/^\s*BUILDCHAIN_RUNTIME_AUTHORIZATION_JSON:.*$/mu, "");
  assert.throws(
    () => assertPromotionCertificationWiring(workflow),
    /promotion certification is missing/u,
  );
});

test("v4 floating policy contract check rejects a heavy job without trust-gate", () => {
  const source = `jobs:\n  resolve-source:\n    needs:\n      - trust-gate\n  build-native:\n    needs:\n      - resolve-source\n`;
  assert.match(workflowJobBlock(source, "build-native"), /resolve-source/u);
  assert.throws(
    () => assertTrustGatedJobs(source, ["resolve-source", "build-native"]),
    /build-native is not directly gated by trust-gate/u,
  );
});

test("generated consumer workflow persists v4 and declares both contract locks", () => {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-policy-template-"),
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
