import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { generateChannelPromotionWorkflow } from "../scripts/generate-channel-promotion-workflow.mjs";
import { resolvePromotionChannel } from "../packages/core/release/promotion/channel.js";

test("publication routes derive product intent without selecting an execution runtime", () => {
  for (const [targetRef, publicationChannel, channel] of [
    ["alpha/v22/v22.22", "alpha", "alpha"],
    ["release/v4/v4.1", "release", "stable"],
    ["publish-gate/major", "major", "stable"],
  ]) assert.deepEqual(resolvePromotionChannel({ targetRef }), { targetRef, publicationChannel, channel });
  assert.throws(() => resolvePromotionChannel({ targetRef: "alpha/v4/v4.1", publicationChannel: "release" }), /does not match/);
  for (const targetRef of ["", "dev/v4/v4.1", "major-gate"]) assert.throws(() => resolvePromotionChannel({ targetRef }), /unsupported/);
});
test("channel CLI rejects a secondary runtime selector", () => {
  const command = "packages/core/release/commands/promotion-channel-router.mjs";
  const ok = spawnSync(process.execPath, [command, "--target-ref", "alpha/v4/v4.1"], {encoding:"utf8"});
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), resolvePromotionChannel({targetRef:"alpha/v4/v4.1"}));
  const rejected = spawnSync(process.execPath, [command, "--target-ref", "alpha/v4/v4.1", "--buildchain-ref", "v4-alpha"], {encoding:"utf8"});
  assert.notEqual(rejected.status, 0);
});
test("generated promotion API forwards one selected runtime and every declared business result", () => {
  const source=fs.readFileSync(".github/workflows/.release-promote.yml","utf8");
  const generated=generateChannelPromotionWorkflow(source);
  const api=YAML.parse(generated), component=YAML.parse(source);
  assert.deepEqual(api,YAML.parse(fs.readFileSync(".github/workflows/public-release-promote.yml","utf8")));
  assert.deepEqual(Object.keys(api.on.workflow_call.inputs),["request-json","runtime-ref","contract-lock","runtime-selection"]);
  for(const output of Object.keys(component.on.workflow_call.outputs)) assert.equal(api.on.workflow_call.outputs[output].value,`\${{ jobs.invoke.outputs.${output} }}`);
  assert.deepEqual(api.jobs.invoke.with, {"request-json":"${{ needs.consumer-admission.outputs.invocation-json }}", "runtime-selection":"${{ needs.execution-runtime.outputs.selection }}"});
  assert.equal(api.jobs.invoke.uses,"./.github/workflows/.release-promote.yml");
  assert.doesNotMatch(generated,/runtime-authorization|matrix:|Build native|pnpm run build/);
});
