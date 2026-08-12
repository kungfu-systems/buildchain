import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBuildchainChannelBinding, parseBuildchainRefIdentity } from "../packages/core/buildchain-channel-identity.js";

test("channel identity is generic across majors and exact releases", () => {
  for (const major of [2, 3, 7, 42]) {
    assert.deepEqual(parseBuildchainRefIdentity(`v${major}`), {
      ref: `v${major}`,
      kind: "official-channel",
      channel: "stable",
      major,
    });
    assert.deepEqual(parseBuildchainRefIdentity(`v${major}-alpha`), {
      ref: `v${major}-alpha`,
      kind: "official-channel",
      channel: "alpha",
      major,
    });
    assert.equal(parseBuildchainRefIdentity(`v${major}.4.1`).channel, "stable");
    assert.equal(parseBuildchainRefIdentity(`v${major}.4.1-alpha.9`).channel, "alpha");
  }
});

test("stable and alpha each require a coherent shell runtime lock triad", () => {
  for (const [channel, suffix] of [
    ["stable", ""],
    ["alpha", "-alpha"],
  ]) {
    const result = evaluateBuildchainChannelBinding({
      workflowShellRef: `kungfu-systems/buildchain/.github/workflows/build.yml@v7${suffix}`,
      runtimeRef: `v7${suffix}`,
      lockRef: `v7${suffix}`,
    });
    assert.equal(result.ok, true, `${channel} should be internally coherent`);
    assert.equal(result.channel, channel);
    assert.equal(result.major, 7);
  }
});

test("every cross-channel or cross-major shell runtime lock permutation fails closed", () => {
  const cases = [
    { workflowShellRef: "v3", runtimeRef: "v3-alpha", lockRef: "v3" },
    { workflowShellRef: "v3", runtimeRef: "v3", lockRef: "v3-alpha" },
    { workflowShellRef: "v3-alpha", runtimeRef: "v3", lockRef: "v3-alpha" },
    { workflowShellRef: "v3", runtimeRef: "v4", lockRef: "v3" },
    { workflowShellRef: "v3", runtimeRef: "v3", lockRef: "v4" },
    {
      workflowShellRef: "v3",
      runtimeRef: "v3",
      lockRef: "v3",
      lockMajorLine: "v4",
    },
    { workflowShellRef: "v3", runtimeRef: "v3", lockRef: "" },
  ];
  for (const value of cases) {
    const result = evaluateBuildchainChannelBinding(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.status, "channel-binding-mismatch");
    assert.ok(result.reasons.length > 0);
  }
});

test("trusted opaque runtimes inherit a declared lane but never bypass its major", () => {
  for (const runtimeRef of ["train/v7/v7.2/runtime-loader", "authority/v7/v7.2/artifact-signing", "a".repeat(40)]) {
    assert.equal(
      evaluateBuildchainChannelBinding({
        workflowShellRef: "a".repeat(40),
        expectedChannel: "alpha",
        expectedMajor: 7,
        runtimeRef,
        lockRef: "v7-alpha",
        allowOpaqueRuntime: true,
      }).ok,
      true,
    );
  }
  assert.equal(
    evaluateBuildchainChannelBinding({
      workflowShellRef: "a".repeat(40),
      expectedChannel: "stable",
      expectedMajor: 7,
      runtimeRef: "train/v8/v8.1/runtime-loader",
      lockRef: "v7",
      allowOpaqueRuntime: true,
    }).ok,
    false,
  );
  assert.equal(
    evaluateBuildchainChannelBinding({
      workflowShellRef: "v7",
      runtimeRef: "a".repeat(40),
      lockRef: "v7",
    }).ok,
    false,
    "opaque runtimes require a trusted lane binding",
  );
});

test("train shells supply their major while the router supplies their channel", () => {
  assert.equal(
    evaluateBuildchainChannelBinding({
      workflowShellRef: "train/v3/v3.0/consumer-equivalent-self-dogfood",
      expectedChannel: "alpha",
      runtimeRef: "v3-alpha",
      lockRef: "v3-alpha",
    }).ok,
    true,
  );
  assert.equal(
    evaluateBuildchainChannelBinding({
      workflowShellRef: "train/v3/v3.0/consumer-equivalent-self-dogfood",
      runtimeRef: "v3-alpha",
      lockRef: "v3-alpha",
    }).ok,
    false,
    "train shells still require an explicit routed channel",
  );
  assert.equal(
    evaluateBuildchainChannelBinding({
      workflowShellRef: "a".repeat(40),
      expectedChannel: "alpha",
      runtimeRef: "v3-alpha",
      lockRef: "v3-alpha",
    }).ok,
    false,
    "exact-SHA shells still require an explicit major",
  );
});
