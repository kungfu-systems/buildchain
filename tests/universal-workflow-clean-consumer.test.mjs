import { inspectWorkflowJob, readWorkflow } from "../scripts/workflow-action-graph.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
test("the Bootstrap shell prepares a clean release consumer before candidate execution", () => {
  const graph = inspectWorkflowJob(".github/workflows/public-ops-bootstrap.yml", "execute");
  const names = graph.steps.map(step => step.name);
  const setup = names.indexOf("Set up release-promotion Node.js"), install = names.indexOf("Install release-promotion consumer dependencies");
  assert.ok(setup >= 0 && install > setup && names.indexOf("Execute candidate engine") > install);
  const step = graph.steps[install];
  assert.match(step.if, /release-candidate-promote/);
  assert.match(step.run, /corepack pnpm@11\.7\.0 install --frozen-lockfile --ignore-scripts/);
  const admit = inspectWorkflowJob(".github/workflows/public-ops-bootstrap.yml", "admit");
  assert.ok(admit.job.outputs["capability-id"]);
  assert.ok(admit.steps.some(step => step.id === "inspect"));
});

test("the exact candidate runtime can prepare an older clean Bootstrap consumer", () => {
  const engine = fs.readFileSync(
    new URL("../packages/core/workflow/commands/universal-workflow-engine.mjs", import.meta.url),
    "utf8",
  );
  const execute = engine.indexOf("async function executeReleasePromotion");
  assert.ok(
    engine.indexOf(
      "prepareReleasePromotionConsumerDependencies(repository)",
      execute,
    ) < engine.indexOf("resolveReleaseCandidateArtifacts({", execute),
  );
  assert.match(
    engine,
    /pnpm@11\.7\.0 install --frozen-lockfile --ignore-scripts"\.split\(" "\), \{ stdio: \["ignore", 2, 2\] \}/u,
  );
  assert.doesNotMatch(engine, /stdio: "inherit"/u);
  assert.match(engine, /node_modules\/@kungfu-tech\/kfd\/package\.json/u);
  assert.match(engine, /\.buildchain\/runtime\/node_modules/u);
  assert.match(engine, /fs\.renameSync\(consumerModules, runtimeModules\)/u);
  assert.match(
    engine,
    /fs\.symlinkSync\([\s\S]*runtimeModules[\s\S]*consumerModules[\s\S]*"dir"/u,
  );
  assert.match(engine, /ACTIONS_ID_TOKEN_REQUEST_URL/u);
  assert.match(engine, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/u);
  assert.match(
    engine,
    /exec corepack pnpm@11\.7\.0 dlx npm@\$\{TRUSTED_PUBLISHING_NPM_VERSION\} "\$@"/u,
  );
  assert.match(
    engine,
    /if \(payload\.inputs\["trusted-publishing"\] === true\)[\s\S]*prepareTrustedPublishingNpm\(\)/u,
  );
});
