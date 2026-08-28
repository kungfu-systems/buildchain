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
  { major: 4 },
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
    routerRef: "v3", routerSha: "",
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
    routerRef: sha, routerSha: sha,
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
  const advanced = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const generated = generateChannelPromotionWorkflow(advanced, {
    major: 4,
    shellRouting,
  });
  const current = fs.readFileSync(
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
    "utf8",
  );
  const internal = new Set(
    workflowFields(advanced, "inputs").filter(
      (name) =>
        name.startsWith("promotion-") ||
        name === "publication-authority-workflow-path" ||
        name === "buildchain-expected-channel" ||
        name === "buildchain-expected-major",
    ),
  );
  const expectedInputs = workflowFields(advanced, "inputs").filter(
    (name) => !internal.has(name),
  );
  expectedInputs.push("buildchain-channel");
  const actualInputs = workflowFields(generated, "inputs");
  const expectedOutputs = workflowFields(advanced, "outputs");
  const actualOutputs = workflowFields(generated, "outputs");

  assert.equal(current, generated);
  assert.deepEqual([...actualInputs].sort(), [...expectedInputs].sort());
  assert.equal(new Set(actualInputs).size, actualInputs.length);
  assert.equal(
    generated.match(
      /buildchain-expected-channel: \$\{\{ needs\.resolve-promotion\.outputs\.channel \}\}/g,
    )?.length,
    1,
  );
  assert.equal(generated.match(/buildchain-expected-major: "4"/g)?.length, 1);
  for (const output of expectedOutputs) {
    assert.ok(actualOutputs.includes(output), `missing output ${output}`);
  }
  assert.equal(new Set(actualOutputs).size, actualOutputs.length);
});

test("generated promotion router exposes one alpha canonical publisher", () => {
  const advanced = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const generated = generateChannelPromotionWorkflow(advanced, {
    major: 4,
    shellRouting,
  });

  assert.match(generated, /^  invoke:/m);
  assert.match(
    generated,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.release-candidate-promote\.yml@v4-alpha/u,
  );
  assert.doesNotMatch(generated, /^  (?:alpha|stable):/m);
  assert.doesNotMatch(
    generated,
    /\.release-candidate-promote\.yml@v4(?:\n|$)/u,
  );
});

test("canonical invoke forwards immutable routing identity and typed override state", () => {
  const advanced = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const generated = generateChannelPromotionWorkflow(advanced, {
    major: 4,
    shellRouting,
  });
  const invokeBlock = generated.slice(generated.indexOf("  invoke:\n"));

  assert.match(
    invokeBlock,
    /^      promotion-shell-ref: \$\{\{ needs\.resolve-promotion\.outputs\.shell-call-ref \}\}$/m,
  );
  assert.match(
    invokeBlock,
    /^      buildchain-ref: \$\{\{ needs\.resolve-promotion\.outputs\.runtime-sha \}\}$/m,
  );
  assert.match(
    invokeBlock,
    /^      promotion-override-used: \$\{\{ needs\.resolve-promotion\.outputs\.override-used == 'true' \}\}$/m,
  );
  assert.doesNotMatch(
    invokeBlock,
    /^      promotion-override-used: \$\{\{ needs\.resolve-promotion\.outputs\.override-used \}\}$/m,
  );
});

test("promotion router contains no native build or provider mutation implementation", () => {
  const router = fs.readFileSync(
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
    "utf8",
  );
  assert.doesNotMatch(router, /matrix:|Build native|pnpm run build/);
  assert.doesNotMatch(
    router,
    /actions\/v4-release-candidate-promote/,
  );
  assert.match(router, /^  resolve-promotion:/m);
  assert.match(router, /^  consumer-admission:/m);
  assert.match(router, /^  invoke:/m);
});
