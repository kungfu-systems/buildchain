import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  generateChannelPromotionWorkflow,
  parsePromotionShellRouting,
} from "../scripts/generate-channel-promotion-workflow.mjs";
import { resolvePromotionChannel } from "../scripts/promotion-channel-router.mjs";
import { resolvePromotionIdentities } from "../scripts/promotion-identity-resolver.mjs";

const root = path.resolve(import.meta.dirname, "..");
const shellRouting = parsePromotionShellRouting(
  fs.readFileSync(path.join(root, ".buildchain/promotion-shell-routing.json"), "utf8"),
  { major: 3 },
);

const base = {
  requestedChannel: "auto",
  requestedRef: "",
  routerRef: "v3",
  packageVersion: "3.0.1-alpha.0",
};

test("alpha promotion selects the alpha workflow shell, runtime, and target", () => {
  assert.deepEqual(resolvePromotionChannel({
    ...base,
    targetRef: "alpha/v22/v22.22",
  }), {
    targetRef: "alpha/v22/v22.22",
    publicationChannel: "alpha",
    channel: "alpha",
    major: 3,
    shellRef: "v3-alpha",
    runtimeRef: "v3-alpha",
    overrideUsed: false,
    selectionSource: "publish-channel",
    reason: "publish-channel=alpha",
  });
});

test("release and major promotion select the stable workflow shell and runtime", () => {
  for (const [targetRef, publicationChannel] of [
    ["release/v3/v3.0", "release"],
    ["publish-gate/major", "major"],
  ]) {
    const result = resolvePromotionChannel({ ...base, targetRef, publicationChannel });
    assert.equal(result.channel, "stable");
    assert.equal(result.shellRef, "v3");
    assert.equal(result.runtimeRef, "v3");
    assert.equal(result.publicationChannel, publicationChannel);
  }
});

test("channel and target mismatches fail closed", () => {
  assert.throws(
    () => resolvePromotionChannel({ ...base, targetRef: "alpha/v3/v3.0", publicationChannel: "release" }),
    /does not match target ref/,
  );
  assert.throws(
    () => resolvePromotionChannel({ ...base, targetRef: "alpha/v3/v3.0", requestedChannel: "stable" }),
    /requires alpha shell\/runtime/,
  );
});

test("consumer target version does not override the Buildchain major", () => {
  const result = resolvePromotionChannel({ ...base, targetRef: "release/v22/v22.22" });
  assert.equal(result.major, 3);
  assert.equal(result.shellRef, "v3");
  assert.equal(result.runtimeRef, "v3");
});

test("train and exact-SHA overrides are always bound to the target shell lane", () => {
  for (const requestedRef of ["train/v3/v3.0/promotion-router", "a".repeat(40)]) {
    const result = resolvePromotionChannel({ ...base, targetRef: "alpha/v3/v3.0", requestedRef });
    assert.equal(result.channel, "alpha");
    assert.equal(result.shellRef, "v3-alpha");
    assert.equal(result.runtimeRef, requestedRef);
    assert.equal(result.overrideUsed, true);
  }
  assert.equal(
    resolvePromotionChannel({
      ...base,
      targetRef: "alpha/v3/v3.0",
      requestedChannel: "alpha",
      requestedRef: "a".repeat(40),
    }).channel,
    "alpha",
  );
});

test("an exact runtime pin matching the reusable workflow SHA is not an override", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(resolvePromotionChannel({
    ...base,
    targetRef: "alpha/v3/v3.0",
    requestedRef: sha,
    routerRef: sha,
    routerSha: sha.toUpperCase(),
  }), {
    targetRef: "alpha/v3/v3.0",
    publicationChannel: "alpha",
    channel: "alpha",
    major: 3,
    shellRef: "v3-alpha",
    runtimeRef: sha,
    overrideUsed: false,
    selectionSource: "trusted-router-sha",
    reason: `explicit Buildchain runtime ref ${sha} matches the reusable workflow SHA`,
  });
});

test("a matching workflow ref cannot authorize a different runtime SHA", () => {
  const requestedRef = "a".repeat(40);
  const result = resolvePromotionChannel({
    ...base,
    targetRef: "alpha/v3/v3.0",
    requestedRef,
    routerRef: requestedRef,
    routerSha: "b".repeat(40),
  });
  assert.equal(result.overrideUsed, true);
  assert.equal(result.selectionSource, "explicit-buildchain-ref+channel-evidence");
});

test("floating promotion refs resolve once even when the ref moves during routing", async () => {
  const firstV3 = "1".repeat(40);
  const movedV3 = "2".repeat(40);
  let calls = 0;
  const identities = await resolvePromotionIdentities({
    routerRef: "v3-alpha",
    routerSha: "a".repeat(40),
    shellRef: "v3",
    shellCallRef: "v3",
    runtimeRef: "v3",
    resolveRef: async (ref) => {
      assert.equal(ref, "v3");
      calls += 1;
      return calls === 1 ? firstV3 : movedV3;
    },
  });

  assert.equal(calls, 1);
  assert.equal(identities.shellRef, "v3");
  assert.equal(identities.shellCallRef, "v3");
  assert.equal(identities.runtimeRef, "v3");
  assert.equal(identities.shellSha, firstV3);
  assert.equal(identities.runtimeSha, firstV3);
});

function workflowFields(source, section) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `    ${section}:`);
  const result = [];
  for (const line of lines.slice(start + 1)) {
    if (/^    \S/.test(line)) break;
    const match = line.match(/^      ([a-z0-9-]+):$/);
    if (match) result.push(match[1]);
  }
  return result;
}

test("generated promotion router preserves every public input and output exactly once", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const generated = generateChannelPromotionWorkflow(advanced, { major: 3, shellRouting });
  const current = fs.readFileSync(path.join(root, ".github/workflows/release-candidate-promote.yml"), "utf8");
  const internal = new Set(workflowFields(advanced, "inputs").filter((name) => name.startsWith("promotion-") || name === "publication-authority-workflow-path"));
  const expectedInputs = workflowFields(advanced, "inputs").filter((name) => !internal.has(name));
  expectedInputs.push("buildchain-channel", "buildchain-alpha-contract-lock-path", "buildchain-stable-contract-lock-path");
  const actualInputs = workflowFields(generated, "inputs");
  const expectedOutputs = workflowFields(advanced, "outputs");
  const actualOutputs = workflowFields(generated, "outputs");

  assert.equal(current, generated);
  assert.deepEqual([...actualInputs].sort(), [...expectedInputs].sort());
  assert.equal(new Set(actualInputs).size, actualInputs.length);
  for (const output of expectedOutputs) assert.ok(actualOutputs.includes(output), `missing output ${output}`);
  assert.equal(new Set(actualOutputs).size, actualOutputs.length);
});

test("generated router delegates alpha and stable lanes to their configured shell refs", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const fixture = advanced.replace(
    "name: Release Candidate Promote Advanced",
    "name: Release Candidate Promote Advanced Alpha Fixture",
  );
  const generated = generateChannelPromotionWorkflow(fixture, { major: 3, shellRouting });

  assert.ok(
    generated.includes(
      `${shellRouting.alpha.workflowPath}@${shellRouting.alpha.callRef}`,
    ),
  );
  assert.match(generated, /\.release-candidate-promote\.yml@v3(?:\n|$)/);
  assert.match(
    generated,
    /publication-authority-workflow-path: \.github\/workflows\/\.release-candidate-promote\.yml/,
  );
  assert.doesNotMatch(
    generated,
    /publication-authority-workflow-path: \.github\/workflows\/release-candidate-promote\.yml/,
  );
  assert.notEqual(fixture, advanced);
  assert.doesNotMatch(generated, /Advanced Alpha Fixture/);
});

test("stable route calls the hidden advanced workflow through the current major ref", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const generated = generateChannelPromotionWorkflow(advanced, { major: 3, shellRouting });

  assert.deepEqual(shellRouting.stable, {
    logicalRef: "v3",
    callRef: "v3",
    workflowPath: ".github/workflows/.release-candidate-promote.yml",
    forwardInternalInputs: true,
    unsupportedInputs: [
      "github-artifact-attestation-environment",
      "github-artifact-attestation-policy-json",
      "github-artifact-attestation-retention-days",
      "publication-gate-command",
      "publication-gate-controller-sha",
      "publication-authority-workflow-path",
      "declarative-release-tail",
      "publication-consumer-qualification-controller-sha",
      "release-activation-command",
      "release-activation-receipt-set-path",
      "release-candidate-wait-seconds",
      "release-candidate-family-assignment-id",
      "release-candidate-family-evidence-required",
      "release-candidate-family-evidence-root",
      "release-candidate-family-initiative-id",
      "release-passport-attachment-command",
      "release-passport-adopter-delivery-json",
      "release-passport-evidence-command",
      "release-passport-evidence-jsons",
      "release-passport-evidence-path",
      "release-passport-kfd-adopter-manifest-json",
      "release-passport-kfd-adopter-manifest-gate-json",
      "release-passport-kfd-support-matrix-json",
      "release-passport-kfd-product-gate-jsons",
      "release-propagation-config-path",
      "resume-buildchain-runtime-sha",
      "resume-candidate-repository",
      "resume-candidate-run-id",
      "resume-expected-candidate-root",
      "resume-expected-candidate-runtime-sha",
      "resume-expected-source-tree",
      "resume-expected-workflow-file",
      "resume-expected-workflow-name",
      "resume-transaction-id",
    ],
  });
  assert.match(generated, /STABLE_SHELL_REF: v3/);
  assert.match(generated, /STABLE_SHELL_CALL_REF: v3/);
  assert.match(generated, /STABLE_SHELL_WORKFLOW_PATH: \.github\/workflows\/\.release-candidate-promote\.yml/);
  assert.match(generated, /shell-call-ref: \$\{\{ steps\.identities\.outputs\.shell-call-ref \}\}/);
  assert.match(
    generated,
    /BUILDCHAIN_ROUTER_REPOSITORY: \$\{\{ inputs\.buildchain-repository \}\}/,
  );
  assert.match(
    generated,
    /BUILDCHAIN_RESUME_RUNTIME_SHA: \$\{\{ inputs\.resume-buildchain-runtime-sha \}\}/,
  );
  assert.match(generated, /Recovery router ref does not match resume-buildchain-runtime-sha/);
  assert.doesNotMatch(generated, /job\.workflow_(?:repository|sha)/);
  assert.match(generated, /ref: \$\{\{ steps\.router\.outputs\.sha \}\}/);
  assert.match(generated, /ref: \$\{\{ steps\.identities\.outputs\.shell-sha \}\}/);
  assert.match(generated, /ref: \$\{\{ steps\.identities\.outputs\.runtime-sha \}\}/);
});

test("configured alpha train calls the matching advanced shell", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const generated = generateChannelPromotionWorkflow(advanced, { major: 3, shellRouting });

  assert.match(generated, /ALPHA_SHELL_REF: v3-alpha/);
  assert.ok(generated.includes(`ALPHA_SHELL_CALL_REF: ${shellRouting.alpha.callRef}`));
  assert.ok(
    generated.includes(
      `uses: kungfu-systems/buildchain/.github/workflows/.release-candidate-promote.yml@${shellRouting.alpha.callRef}`,
    ),
  );
});

test("stable route forwards only inputs supported by the current workflow shell", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const generated = generateChannelPromotionWorkflow(advanced, { major: 3, shellRouting });
  const stableBlock = generated.slice(generated.indexOf("  stable:\n"));

  for (const name of workflowFields(advanced, "inputs")) {
    if (shellRouting.stable.unsupportedInputs.includes(name)) continue;
    assert.match(stableBlock, new RegExp(`^      ${name}:`, "m"));
  }
  for (const name of shellRouting.stable.unsupportedInputs) {
    assert.doesNotMatch(stableBlock, new RegExp(`^      ${name}:`, "m"));
  }
  assert.doesNotMatch(stableBlock, /^      release-passport-kfd-adopter-manifest-json:/m);
  assert.doesNotMatch(stableBlock, /^      release-passport-kfd-adopter-manifest-gate-json:/m);
  assert.doesNotMatch(stableBlock, /^      release-passport-kfd-support-matrix-json:/m);
  assert.doesNotMatch(stableBlock, /^      release-passport-kfd-product-gate-jsons:/m);
  assert.doesNotMatch(stableBlock, /^      github-artifact-attestation-policy-json:/m);
  assert.doesNotMatch(stableBlock, /^      github-artifact-attestation-environment:/m);
  assert.doesNotMatch(stableBlock, /^      github-artifact-attestation-retention-days:/m);
  assert.doesNotMatch(stableBlock, /^      release-candidate-family-assignment-id:/m);
  assert.doesNotMatch(stableBlock, /^      release-candidate-family-evidence-required:/m);
  assert.doesNotMatch(stableBlock, /^      release-candidate-family-evidence-root:/m);
  assert.doesNotMatch(stableBlock, /^      release-candidate-family-initiative-id:/m);
  assert.doesNotMatch(stableBlock, /^      release-passport-attachment-command:/m);
  assert.doesNotMatch(stableBlock, /^      release-passport-adopter-delivery-json:/m);
  assert.doesNotMatch(stableBlock, /^      release-passport-evidence-jsons:/m);
  assert.doesNotMatch(stableBlock, /^      publication-gate-command:/m);
  assert.doesNotMatch(stableBlock, /^      publication-gate-controller-sha:/m);
  assert.doesNotMatch(stableBlock, /^      release-candidate-wait-seconds:/m);
  assert.match(stableBlock, /^      standalone-binary-distribution:/m);
  assert.match(stableBlock, /^      publish-rematerialize-on-resume:/m);
  assert.match(
    stableBlock,
    /^      promotion-shell-ref: \$\{\{ needs\.resolve-promotion\.outputs\.shell-call-ref \}\}$/m,
  );
  assert.match(stableBlock, /^      buildchain-ref:/m);
  assert.match(stableBlock, /^      buildchain-contract-lock-path:/m);
  assert.match(stableBlock, /^      channel:/m);
  assert.match(stableBlock, /^      target-ref:/m);
  assert.match(stableBlock, /^      buildchain-ref: \$\{\{ needs\.resolve-promotion\.outputs\.runtime-sha \}\}$/m);
});

test("alpha router coerces string job output before forwarding a boolean input", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const generated = generateChannelPromotionWorkflow(advanced, { major: 3, shellRouting });
  const alphaBlock = generated.slice(generated.indexOf("  alpha:\n"), generated.indexOf("  stable:\n"));

  assert.match(
    alphaBlock,
    /^      promotion-override-used: \$\{\{ needs\.resolve-promotion\.outputs\.override-used == 'true' \}\}$/m,
  );
  assert.doesNotMatch(
    alphaBlock,
    /^      promotion-override-used: \$\{\{ needs\.resolve-promotion\.outputs\.override-used \}\}$/m,
  );
});

test("promotion router contains no native build job and delegates candidate reuse to the advanced shell", () => {
  const router = fs.readFileSync(path.join(root, ".github/workflows/release-candidate-promote.yml"), "utf8");
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const bindingVerifier = fs.readFileSync(
    path.join(root, "scripts/verify-promotion-router-binding.sh"),
    "utf8",
  );
  assert.ok(!/matrix:|Build native|pnpm run build/.test(router) && /if \[\[ "\$\{ref\}" =~ \^\[0-9A-Fa-f\]\{40\}\$ \]\]; then sha="\$\{ref,,\}"/.test(router));
  assert.match(advanced, /Resolve PR-stage release candidate/);
  assert.match(advanced, /release-candidate-resolver\.mjs/);
  assert.match(advanced, /CALLED_WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(
    advanced,
    /bash \.buildchain\/promotion-shell\/scripts\/verify-promotion-router-binding\.sh/,
  );
  assert.match(
    bindingVerifier,
    /\[\[ "\$\{CALLED_WORKFLOW_SHA\}" = "\$\{SHELL_SHA\}" \]\]/,
  );
  assert.doesNotMatch(advanced, /strategy:\n\s+matrix:/);
});
