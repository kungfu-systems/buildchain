import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createBuildchainContractLock,
  createBuildchainContractWorld,
} from "../packages/core/buildchain-contract.js";
import { initBuildchainRepo } from "../scripts/init-repo.mjs";
import {
  assertPromotionCertificationWiring,
  assertTrustGatedJobs,
  checkFloatingConsumerPolicyContract,
  workflowJobBlock,
} from "../scripts/check-floating-consumer-policy-contract.mjs";
import {
  resolveFloatingConsumerPolicyAuthority,
  scanFloatingConsumerPolicy,
} from "../packages/core/floating-consumer-policy.js";
import { scanRuntimeSelectorPersistence } from "../packages/core/runtime-selector-persistence.js";

const root = path.resolve(import.meta.dirname, "..");

test("v4 floating policy contract check accepts the repository wiring", () => {
  assert.equal(checkFloatingConsumerPolicyContract().ok, true);
});

test("public adopter delivery uploads the receipt resolved under the consumer root", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/public-build-adopter-qualification.yml"),
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
    /BUILDCHAIN_INVOCATION_SOURCE_PATH: \$\{\{ inputs\['invocation-source-path'\] \|\| \(github\.repository == 'kungfu-systems\/buildchain' && '\.github\/workflows\/self-build-adopter-dogfood\.yml' \|\| ''\) \}\}/u,
  );
  assert.match(
    workflow,
    /--repository "\$\{\{ inputs\['consumer-repository'\] \|\| github\.repository \}\}"\n\s+--source-sha "\$\{\{ steps\.consumer-source\.outputs\.sha \}\}"/u,
  );
  assert.doesNotMatch(workflow, /github\.event_name == 'workflow_dispatch'/u);
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
  fs.cpSync(path.join(root, ".github"), path.join(consumerRoot, ".github"), {
    recursive: true,
  });
  for (const action of fs.readdirSync(path.join(root, "actions"))) {
    fs.mkdirSync(path.join(consumerRoot, "actions", action), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(root, "actions", action, "action.yml"),
      path.join(consumerRoot, "actions", action, "action.yml"),
    );
  }
  writeCurrentRuntimeLocks(consumerRoot);
  const authority = resolveFloatingConsumerPolicyAuthority({
    runtimeRoot: root,
    callerRoot: consumerRoot,
  });
  const result = scanFloatingConsumerPolicy({
    root: consumerRoot,
    repository: "kungfu-systems/buildchain",
    sourceSha: "a".repeat(40),
    invokedWorkflow: ".github/workflows/.release-candidate-promote.yml",
    invocationSourcePath: ".github/workflows/self-release-promote.yml",
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
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
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
  writeCurrentRuntimeLocks(consumerRoot);
  try {
    const result = scanFloatingConsumerPolicy({
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
      "BUILDCHAIN_INVOCATION_SOURCE_PATH: ${{ inputs.publication-publisher-workflow-path == '.github/workflows/self-ops-promotion-recovery.yml' && '.github/workflows/release-candidate-promote.yml' || inputs.publication-publisher-workflow-path }}",
    ),
  );
  assert.ok(
    publicPromotion.includes(
      "BUILDCHAIN_INVOKED_WORKFLOW: ${{ inputs.publication-publisher-workflow-path == '.github/workflows/self-ops-promotion-recovery.yml' && '.github/workflows/.release-candidate-promote.yml' || '.github/workflows/release-candidate-promote.yml' }}",
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
        'node "${policy_runtime}/scripts/consumer-policy.mjs" certify',
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
