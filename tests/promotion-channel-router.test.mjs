import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  generateChannelPromotionWorkflow,
  parsePromotionShellRouting,
} from "../scripts/generate-channel-promotion-workflow.mjs";
import { resolvePromotionChannel } from "../scripts/promotion-channel-router.mjs";

const root = path.resolve(import.meta.dirname, "..");
const shellRouting = parsePromotionShellRouting(
  fs.readFileSync(path.join(root, ".buildchain/promotion-shell-routing.json"), "utf8"),
  { major: 2 },
);

const base = {
  requestedChannel: "auto",
  requestedRef: "",
  routerRef: "v2",
  packageVersion: "2.14.3-alpha.0",
};

test("alpha promotion selects the alpha workflow shell, runtime, and target", () => {
  assert.deepEqual(resolvePromotionChannel({
    ...base,
    targetRef: "alpha/v2/v2.14",
  }), {
    targetRef: "alpha/v2/v2.14",
    publicationChannel: "alpha",
    channel: "alpha",
    major: 2,
    shellRef: "v2-alpha",
    runtimeRef: "v2-alpha",
    overrideUsed: false,
    selectionSource: "publish-channel",
    reason: "publish-channel=alpha",
  });
});

test("release and major promotion select the stable workflow shell and runtime", () => {
  for (const [targetRef, publicationChannel] of [
    ["release/v2/v2.14", "release"],
    ["publish-gate/major", "major"],
  ]) {
    const result = resolvePromotionChannel({ ...base, targetRef, publicationChannel });
    assert.equal(result.channel, "stable");
    assert.equal(result.shellRef, "v2");
    assert.equal(result.runtimeRef, "v2");
    assert.equal(result.publicationChannel, publicationChannel);
  }
});

test("channel, target, major, and official ref mismatches fail closed", () => {
  assert.throws(
    () => resolvePromotionChannel({ ...base, targetRef: "alpha/v2/v2.14", publicationChannel: "release" }),
    /does not match target ref/,
  );
  assert.throws(
    () => resolvePromotionChannel({ ...base, targetRef: "alpha/v2/v2.14", requestedChannel: "stable" }),
    /requires alpha shell\/runtime/,
  );
  assert.throws(
    () => resolvePromotionChannel({ ...base, targetRef: "release/v3/v3.0", requestedRef: "v2" }),
    /requires Buildchain v3/,
  );
});

test("train and exact-SHA overrides retain auto-only selection and target shell lane", () => {
  for (const requestedRef of ["train/v2/v2.14/promotion-router", "a".repeat(40)]) {
    const result = resolvePromotionChannel({ ...base, targetRef: "alpha/v2/v2.14", requestedRef });
    assert.equal(result.channel, "alpha");
    assert.equal(result.shellRef, "v2-alpha");
    assert.equal(result.runtimeRef, requestedRef);
    assert.equal(result.overrideUsed, true);
  }
  assert.throws(
    () => resolvePromotionChannel({
      ...base,
      targetRef: "alpha/v2/v2.14",
      requestedChannel: "alpha",
      requestedRef: "a".repeat(40),
    }),
    /require buildchain-channel=auto/,
  );
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
  const generated = generateChannelPromotionWorkflow(advanced, { major: 2, shellRouting });
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

test("alpha-only advanced workflow changes are isolated from the stable shell ref", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const fixture = advanced.replace(
    "name: Release Candidate Promote Advanced",
    "name: Release Candidate Promote Advanced Alpha Fixture",
  );
  const generated = generateChannelPromotionWorkflow(fixture, { major: 2, shellRouting });

  assert.match(generated, /\.release-candidate-promote\.yml@v2-alpha/);
  assert.match(generated, /release-candidate-promote\.yml@c95f9fc36b0ac8fb4ff6400189850c4ae683f3ea/);
  assert.doesNotMatch(generated, /\.release-candidate-promote\.yml@v2(?:\n|$)/);
  assert.notEqual(fixture, advanced);
  assert.doesNotMatch(generated, /Advanced Alpha Fixture/);
});

test("stable bootstrap calls the existing public workflow at the immutable v2 SHA", () => {
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  const generated = generateChannelPromotionWorkflow(advanced, { major: 2, shellRouting });

  assert.deepEqual(shellRouting.stable, {
    logicalRef: "v2",
    callRef: "c95f9fc36b0ac8fb4ff6400189850c4ae683f3ea",
    workflowPath: ".github/workflows/release-candidate-promote.yml",
  });
  assert.match(generated, /STABLE_SHELL_REF: v2/);
  assert.match(generated, /STABLE_SHELL_CALL_REF: c95f9fc36b0ac8fb4ff6400189850c4ae683f3ea/);
  assert.match(generated, /STABLE_SHELL_WORKFLOW_PATH: \.github\/workflows\/release-candidate-promote\.yml/);
});

test("promotion router contains no native build job and delegates candidate reuse to the advanced shell", () => {
  const router = fs.readFileSync(path.join(root, ".github/workflows/release-candidate-promote.yml"), "utf8");
  const advanced = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
  assert.doesNotMatch(router, /matrix:|Build native|pnpm run build/);
  assert.match(advanced, /Resolve PR-stage release candidate/);
  assert.match(advanced, /release-candidate-resolver\.mjs/);
  assert.doesNotMatch(advanced, /strategy:\n\s+matrix:/);
});
