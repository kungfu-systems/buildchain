import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import { parse as yaml } from "yaml";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import { pipelinePlatforms } from "../packages/core/workflow/pipeline/platforms.js";

const fixture = () =>
  parse(
    fs.readFileSync(
      "templates/minimal-consumer/binary/.buildchain/buildchain.toml",
      "utf8",
    ),
  );

test("build budgets retain default matrix identity and honor the largest declared platform requirement", () => {
  const config = fixture();
  const original = pipelinePlatforms(compileConsumerPlan(stringify(config)));
  assert.deepEqual(original, [
    { platform: "linux-x64", runner: "ubuntu-24.04" },
  ]);
  config.products[0].timeout_minutes = 180;
  config.products.push({
    ...structuredClone(config.products[0]),
    id: "second",
    timeout_minutes: 120,
  });
  const platforms = pipelinePlatforms(compileConsumerPlan(stringify(config)));
  assert.equal(platforms[0].timeoutMinutes, 180);
  for (const value of [0, -1, 361, 1.5, "180", true]) {
    config.products[0].timeout_minutes = value;
    assert.throws(
      () => compileConsumerPlan(stringify(config)),
      /timeout_minutes/,
    );
    assert.throws(() => pipelinePlatforms(config), /timeout/);
  }
});

test("all product execution jobs consume the same admitted build budget", () => {
  for (const file of [
    ".ops-pipeline-execute.yml",
    ".release-pipeline-products.yml",
    ".release-pipeline-version.yml",
  ]) {
    const workflow = yaml(fs.readFileSync(`.github/workflows/${file}`, "utf8"));
    assert.equal(
      workflow.jobs.build["timeout-minutes"],
      "${{ matrix.timeoutMinutes || 60 }}",
    );
    assert.deepEqual(workflow.jobs.build.permissions, { contents: "read" });
    assert.equal(workflow.jobs.build.secrets, undefined);
    assert.equal(workflow.jobs.build.environment, undefined);
  }
});
