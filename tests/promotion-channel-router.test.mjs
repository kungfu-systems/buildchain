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

test("train and exact-SHA overrides retain auto-only selection and target shell lane", () => {
  for (const requestedRef of ["train/v3/v3.0/promotion-router", "a".repeat(40)]) {
    const result = resolvePromotionChannel({ ...base, targetRef: "alpha/v3/v3.0", requestedRef });
    assert.equal(result.channel, "alpha");
    assert.equal(result.shellRef, "v3-alpha");
    assert.equal(result.runtimeRef, requestedRef);
    assert.equal(result.overrideUsed, true);
  }
  assert.throws(
    () => resolvePromotionChannel({
      ...base,
      targetRef: "alpha/v3/v3.0",
      requestedChannel: "alpha",
      requestedRef: "a".repeat(40),
    }),
    /require buildchain-channel=auto/,
  );
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
  const internal = new Set(workflowFields(advanced, "inputs").filter((name) => name.startsWith("promotion-")));
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

test("generated router delegates alpha and stable lanes to the current major refs", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const fixture = advanced.replace(
    "name: Release Candidate Promote Advanced",
    "name: Release Candidate Promote Advanced Alpha Fixture",
  );
  const generated = generateChannelPromotionWorkflow(fixture, { major: 3, shellRouting });

  assert.match(generated, /\.release-candidate-promote\.yml@v3-alpha/);
  assert.match(generated, /\.release-candidate-promote\.yml@v3(?:\n|$)/);
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
    unsupportedInputs: [],
  });
  assert.match(generated, /STABLE_SHELL_REF: v3/);
  assert.match(generated, /STABLE_SHELL_CALL_REF: v3/);
  assert.match(generated, /STABLE_SHELL_WORKFLOW_PATH: \.github\/workflows\/\.release-candidate-promote\.yml/);
  assert.match(generated, /shell-call-ref: \$\{\{ steps\.identities\.outputs\.shell-call-ref \}\}/);
  assert.match(generated, /BUILDCHAIN_ROUTER_WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(generated, /ref: \$\{\{ steps\.router\.outputs\.sha \}\}/);
  assert.match(generated, /ref: \$\{\{ steps\.identities\.outputs\.shell-sha \}\}/);
  assert.match(generated, /ref: \$\{\{ steps\.identities\.outputs\.runtime-sha \}\}/);
});

test("stable route forwards every input supported by the current workflow shell", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const generated = generateChannelPromotionWorkflow(advanced, { major: 3, shellRouting });
  const stableBlock = generated.slice(generated.indexOf("  stable:\n"));

  for (const name of workflowFields(advanced, "inputs")) {
    assert.match(stableBlock, new RegExp(`^      ${name}:`, "m"));
  }
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
  assert.doesNotMatch(router, /matrix:|Build native|pnpm run build/);
  assert.match(advanced, /Resolve PR-stage release candidate/);
  assert.match(advanced, /release-candidate-resolver\.mjs/);
  assert.match(advanced, /CALLED_WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(advanced, /\[\[ "\$\{CALLED_WORKFLOW_SHA\}" = "\$\{SHELL_SHA\}" \]\]/);
  assert.doesNotMatch(advanced, /strategy:\n\s+matrix:/);
});
