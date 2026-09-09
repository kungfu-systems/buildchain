import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { generateChannelPromotionWorkflow } from "../scripts/generate-channel-promotion-workflow.mjs";
import { resolvePromotionChannel } from "../packages/core/release/commands/promotion-channel-router.mjs";
import { resolvePromotionIdentities } from "../packages/core/release/commands/promotion-identity-resolver.mjs";

const root = path.resolve(import.meta.dirname, "..");
const base = {
  requestedChannel: "auto",
  requestedRef: "",
  routerRef: "v4",
  packageVersion: "4.1.0-alpha.0",
};

test("alpha promotion selects the alpha workflow shell, runtime, and target", () => {
  assert.deepEqual(
    resolvePromotionChannel({
      ...base,
      targetRef: "alpha/v22/v22.22",
    }),
    {
      targetRef: "alpha/v22/v22.22",
      publicationChannel: "alpha",
      routerRef: "v4",
      routerSha: "",
      channel: "alpha",
      major: 4,
      shellRef: "v4-alpha",
      runtimeRef: "v4-alpha",
      overrideUsed: false,
      selectionSource: "publish-channel",
      reason: "publish-channel=alpha",
    },
  );
});

test("release and major promotion select the stable workflow shell and runtime", () => {
  for (const [targetRef, publicationChannel] of [
    ["release/v4/v4.0", "release"],
    ["publish-gate/major", "major"],
  ]) {
    const result = resolvePromotionChannel({
      ...base,
      targetRef,
      publicationChannel,
    });
    assert.equal(result.channel, "stable");
    assert.equal(result.shellRef, "v4");
    assert.equal(result.runtimeRef, "v4");
    assert.equal(result.publicationChannel, publicationChannel);
  }
});

test("channel and target mismatches fail closed", () => {
  assert.throws(
    () =>
      resolvePromotionChannel({
        ...base,
        targetRef: "alpha/v4/v4.0",
        publicationChannel: "release",
      }),
    /does not match target ref/,
  );
  assert.throws(
    () =>
      resolvePromotionChannel({
        ...base,
        targetRef: "alpha/v4/v4.0",
        requestedChannel: "stable",
      }),
    /requires alpha shell\/runtime/,
  );
});

test("consumer target version does not override the Buildchain major", () => {
  const result = resolvePromotionChannel({
    ...base,
    targetRef: "release/v22/v22.22",
  });
  assert.equal(result.major, 4);
  assert.equal(result.shellRef, "v4");
  assert.equal(result.runtimeRef, "v4");
});

test("train and exact-SHA overrides are always bound to the target shell lane", () => {
  for (const requestedRef of [
    "train/v4/v4.0/promotion-router",
    "a".repeat(40),
  ]) {
    const result = resolvePromotionChannel({
      ...base,
      targetRef: "alpha/v4/v4.0",
      requestedRef,
    });
    assert.equal(result.channel, "alpha");
    assert.equal(result.shellRef, "v4-alpha");
    assert.equal(result.runtimeRef, requestedRef);
    assert.equal(result.overrideUsed, true);
  }
  assert.equal(
    resolvePromotionChannel({
      ...base,
      targetRef: "alpha/v4/v4.0",
      requestedChannel: "alpha",
      requestedRef: "a".repeat(40),
    }).channel,
    "alpha",
  );
});

test("an exact runtime pin matching the reusable workflow SHA is not an override", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(
    resolvePromotionChannel({
      ...base,
      targetRef: "alpha/v4/v4.0",
      requestedRef: sha,
      routerRef: sha,
      routerSha: sha.toUpperCase(),
    }),
    {
      targetRef: "alpha/v4/v4.0",
      publicationChannel: "alpha",
      routerRef: sha,
      routerSha: sha,
      channel: "alpha",
      major: 4,
      shellRef: "v4-alpha",
      runtimeRef: sha,
      overrideUsed: false,
      selectionSource: "trusted-router-sha",
      reason: `explicit Buildchain runtime ref ${sha} matches the reusable workflow SHA`,
    },
  );
});

test("a matching workflow ref cannot authorize a different runtime SHA", () => {
  const requestedRef = "a".repeat(40);
  const result = resolvePromotionChannel({
    ...base,
    targetRef: "alpha/v4/v4.0",
    requestedRef,
    routerRef: requestedRef,
    routerSha: "b".repeat(40),
  });
  assert.equal(result.overrideUsed, true);
  assert.equal(
    result.selectionSource,
    "explicit-buildchain-ref+channel-evidence",
  );
});

test("floating promotion refs resolve once even when the ref moves during routing", async () => {
  const firstBaseline = "1".repeat(40);
  const movedBaseline = "2".repeat(40);
  let calls = 0;
  const identities = await resolvePromotionIdentities({
    routerRef: "v4-alpha",
    routerSha: "a".repeat(40),
    shellRef: "v4",
    shellCallRef: "v4",
    runtimeRef: "v4",
    resolveRef: async (ref) => {
      assert.equal(ref, "v4");
      calls += 1;
      return calls === 1 ? firstBaseline : movedBaseline;
    },
  });

  assert.equal(calls, 1);
  assert.equal(identities.shellRef, "v4");
  assert.equal(identities.shellCallRef, "v4");
  assert.equal(identities.runtimeRef, "v4");
  assert.equal(identities.shellSha, firstBaseline);
  assert.equal(identities.runtimeSha, firstBaseline);
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

test("promotion API has one versioned request and forwards every declared result exactly once", () => {
  const source = fs.readFileSync(
    path.join(root, ".github/workflows/.release-promote.yml"),
    "utf8",
  );
  const generated = generateChannelPromotionWorkflow(source);
  assert.equal(
    generated,
    fs.readFileSync(
      path.join(root, ".github/workflows/public-release-promote.yml"),
      "utf8",
    ),
  );
  const api = YAML.parse(generated),
    component = YAML.parse(source);
  assert.deepEqual(Object.keys(api.on.workflow_call.inputs), ["request-json"]);
  assert.deepEqual(Object.keys(component.on.workflow_call.inputs), [
    "request-json",
  ]);
  for (const output of Object.keys(component.on.workflow_call.outputs))
    assert.equal(
      api.on.workflow_call.outputs[output].value,
      `\${{ jobs.invoke.outputs.${output} }}`,
    );
  assert.ok(source.split("\n").length <= 300);
  assert.ok(generated.split("\n").length <= 300);
});

test("generated promotion router exposes the current publisher component", () => {
  const advanced = fs.readFileSync(
    path.join(root, ".github/workflows/.release-promote.yml"),
    "utf8",
  );
  const generated = generateChannelPromotionWorkflow(advanced, {
    major: 4,
  });

  assert.match(generated, /^  invoke:/m);
  assert.match(
    generated,
    /uses: \.\/\.github\/workflows\/\.release-promote\.yml/u,
  );
  assert.doesNotMatch(generated, /^  (?:alpha|stable):/m);
  assert.doesNotMatch(
    generated,
    /\.release-candidate-promote\.yml@v4(?:\n|$)/u,
  );
});

test("canonical invoke accepts only the complete consumer-admitted invocation", () => {
  const source = fs.readFileSync(
    path.join(root, ".github/workflows/.release-promote.yml"),
    "utf8",
  );
  const api = YAML.parse(generateChannelPromotionWorkflow(source));
  assert.deepEqual(api.jobs.invoke.with, {
    "request-json": "${{ needs.consumer-admission.outputs.invocation-json }}",
  });
  assert.deepEqual(api.jobs.invoke.needs, [
    "resolve-promotion",
    "consumer-admission",
  ]);
});

test("promotion router contains no native build or provider mutation implementation", () => {
  const router = fs.readFileSync(
    path.join(root, ".github/workflows/public-release-promote.yml"),
    "utf8",
  );
  assert.doesNotMatch(router, /matrix:|Build native|pnpm run build/);
  assert.doesNotMatch(router, /actions\/release\/promote-candidate/);
  assert.match(router, /^  resolve-promotion:/m);
  assert.match(router, /^  consumer-admission:/m);
  assert.match(router, /^  invoke:/m);
});
