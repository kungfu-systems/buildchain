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

const root = path.resolve(import.meta.dirname, "..");

test("v4 floating policy contract check accepts the repository wiring", () => {
  assert.equal(checkV4FloatingConsumerPolicyContract().ok, true);
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

test("bounded alpha recovery admits the floating advanced shell before promotion", () => {
  const relative = ".github/workflows/buildchain-ref-promotion-recovery.yml";
  const workflow = fs.readFileSync(path.join(root, relative), "utf8");
  const authority = resolveV4FloatingConsumerPolicyAuthority({
    runtimeRoot: root,
    callerRoot: root,
  });
  const consumerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-recovery-consumer-"),
  );
  fs.mkdirSync(path.join(consumerRoot, ".buildchain"), { recursive: true });
  for (const lock of ["contract-lock.json", "alpha-contract-lock.json"])
    fs.copyFileSync(
      path.join(root, ".buildchain", lock),
      path.join(consumerRoot, ".buildchain", lock),
    );

  let result;
  try {
    const sourceOnly = scanV4FloatingConsumerPolicy({
      root: consumerRoot,
      repository: "kungfu-systems/buildchain",
      sourceSha: "a".repeat(40),
      invokedWorkflow: ".github/workflows/.release-candidate-promote.yml",
      invocationSourcePath: relative,
      expectedInvocationChannel: "alpha",
      resolvedWorkflowSha: "b".repeat(40),
      resolvedRuntimeSha: "c".repeat(40),
      policy: authority.policy,
      scannerRoot: authority.scannerRoot,
    });
    assert.equal(sourceOnly.ok, false);
    assert.equal(
      sourceOnly.failures.some(
        ({ code }) => code === "invoked-workflow-not-found",
      ),
      true,
    );

    const foreignRepository = scanV4FloatingConsumerPolicy({
      root: consumerRoot,
      invocationRoot: root,
      repository: "kungfu-systems/consumer",
      sourceSha: "a".repeat(40),
      invokedWorkflow: ".github/workflows/.release-candidate-promote.yml",
      invocationSourcePath: relative,
      expectedInvocationChannel: "alpha",
      resolvedWorkflowSha: "b".repeat(40),
      resolvedRuntimeSha: "c".repeat(40),
      policy: authority.policy,
      scannerRoot: authority.scannerRoot,
    });
    assert.equal(foreignRepository.ok, false);
    assert.equal(
      foreignRepository.failures.some(
        ({ code }) => code === "unapproved-v4-selector",
      ),
      true,
    );

    result = scanV4FloatingConsumerPolicy({
      root: consumerRoot,
      invocationRoot: root,
      repository: "kungfu-systems/buildchain",
      sourceSha: "a".repeat(40),
      invokedWorkflow: ".github/workflows/.release-candidate-promote.yml",
      invocationSourcePath: relative,
      expectedInvocationChannel: "alpha",
      resolvedWorkflowSha: "b".repeat(40),
      resolvedRuntimeSha: "c".repeat(40),
      policy: authority.policy,
      scannerRoot: authority.scannerRoot,
    });
  } finally {
    fs.rmSync(consumerRoot, { recursive: true, force: true });
  }

  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.receipt.invocation.visibleSelector, "alpha/v4/v4.0");
  assert.equal(result.receipt.invocation.selectorClass, "protected-bootstrap");
  assert.match(workflow, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  workflow_run:/mu);
  assert.match(
    workflow,
    /promote-alpha-recovery:[\s\S]*needs: consumer-admission[\s\S]*\.release-candidate-promote\.yml@alpha\/v4\/v4\.0/u,
  );
  assert.match(
    workflow,
    /release-passport-v4-runtime-resume-evidence-json: \$\{\{ inputs\['release-passport-v4-runtime-resume-evidence-json'\] \}\}/u,
  );
  assert.match(
    workflow,
    /candidate recovery inputs must be supplied together or omitted together/u,
  );
  assert.match(workflow, /path: \.buildchain\/recovered-source/u);
  assert.match(
    workflow,
    /sparse-checkout:\s+\|\s+\.buildchain\/contract-lock\.json\s+\.buildchain\/alpha-contract-lock\.json/u,
  );
  assert.match(workflow, /sparse-checkout-cone-mode: false/u);
  assert.match(
    workflow,
    /cp "\$\{source_path\}" "\.buildchain\/consumer\/\.buildchain\/\$\{lock\}"/u,
  );
  assert.match(workflow, /git -C \.buildchain\/consumer init --quiet/u);
  assert.match(
    workflow,
    /git -C \.buildchain\/consumer ls-files -- \.github\/workflows \.github\/actions \.buildchain/u,
  );
  assert.doesNotMatch(
    workflow,
    /runtime A\+B evidence is required for cross-runtime candidate resume/u,
  );
  assert.match(
    workflow,
    /release-passport-v4-runtime-resume-evidence-json:\s+\$\{\{ inputs\['release-passport-v4-runtime-resume-evidence-json'\] \}\}/u,
  );
  assert.match(
    workflow,
    /github-release-payload-patterns: \$\{\{ inputs\['resume-candidate-run-id'\] != '' && '\*\.tgz' \|\| '' \}\}/u,
  );
  assert.match(
    workflow,
    /standalone-binary-distribution: \$\{\{ inputs\['resume-candidate-run-id'\] == '' \}\}/u,
  );
  assert.match(workflow, /artifact-patterns: "buildchain-package-\*"/u);
  assert.match(
    workflow,
    /router-ref: \$\{\{ inputs\['resume-buildchain-runtime-ref'\] \}\}/u,
  );
  assert.match(
    workflow,
    /router-sha: \$\{\{ inputs\['resume-buildchain-runtime-sha'\] \}\}/u,
  );
  assert.match(
    workflow,
    /shell-call-ref: \$\{\{ steps\.identities\.outputs\.shell-call-ref \}\}/u,
  );
  assert.match(
    workflow,
    /promotion-shell-ref: \$\{\{ needs\.consumer-admission\.outputs\.shell-call-ref \}\}/u,
  );
  assert.match(
    workflow,
    /BUILDCHAIN_INVOCATION_SOURCE_ROOT: \.buildchain\/router/u,
  );
  assert.match(workflow, /--shell-ref alpha\/v4\/v4\.0/u);
  assert.match(workflow, /--shell-call-ref alpha\/v4\/v4\.0/u);
  assert.match(workflow, /resume-buildchain-runtime-ref:/u);
  assert.match(
    workflow,
    /--buildchain-ref "\$\{\{ inputs\['resume-buildchain-runtime-ref'\] \}\}"/u,
  );
  assert.match(
    workflow,
    /--router-ref "\$\{\{ inputs\['resume-buildchain-runtime-ref'\] \}\}"/u,
  );
  assert.match(
    workflow,
    /--router-sha "\$\{\{ inputs\['resume-buildchain-runtime-sha'\] \}\}"/u,
  );
  assert.match(
    workflow,
    /run: test "\$\{\{ steps\.identities\.outputs\.runtime-sha \}\}" = "\$\{\{ inputs\['resume-buildchain-runtime-sha'\] \}\}"/u,
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

test("v4 floating policy contract rejects an unbound certification root", () => {
  const workflow = fs
    .readFileSync(
      path.join(root, ".github/workflows/.release-candidate-promote.yml"),
      "utf8",
    )
    .replace(
      /^\s*release-passport-v4-consumer-policy-certification-root:.*$/mu,
      "",
    );
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
