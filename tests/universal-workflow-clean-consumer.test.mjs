import { inspectWorkflowJob, readWorkflow } from "../scripts/workflow-action-graph.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
test("the Bootstrap shell prepares a clean release consumer before candidate execution", () => {
  const graph = inspectWorkflowJob(".github/workflows/public-ops-bootstrap.yml", "execute");
  const names = graph.steps.map(step => step.name);
  const setup = graph.steps.findIndex(step => step.uses?.startsWith("actions/setup-node@")), install = names.indexOf("Install release-promotion consumer dependencies");
  assert.ok(setup >= 0 && install > setup && graph.steps.findIndex(step => step.uses?.endsWith("/workflow/engine/execute")) > install);
  const step = graph.steps[install];
  assert.match(step.if, /release-candidate-promote/);
  assert.match(step.uses, /actions\/runtime\/dependencies\/install$/);
  assert.equal(step.with["ignore-scripts"], "true");
  assert.equal(step.with.production, "false");
  const admit = inspectWorkflowJob(".github/workflows/public-ops-bootstrap.yml", "admit");
  assert.ok(admit.job.outputs["capability-id"]);
  assert.ok(admit.steps.some(step => step.id === "inspect"));
});

test("the exact candidate runtime prepares a clean Bootstrap consumer", () => {
  const engine = fs.readFileSync(
    new URL("../packages/core/workflow/engine/release-promotion.js", import.meta.url),
    "utf8",
  );
  const environment = fs.readFileSync(new URL("../packages/core/workflow/engine/release-environment.js", import.meta.url), "utf8");
  const execute = engine.indexOf("async function executeReleasePromotion");
  assert.ok(
    engine.indexOf(
      "prepareReleasePromotionConsumerDependencies(repository)",
      execute,
    ) < engine.indexOf("resolveReleaseCandidateArtifacts({", execute),
  );
  assert.match(
    environment,
    /pnpm@11\.7\.0 install --frozen-lockfile --ignore-scripts"\.split\(" "\),\s*\{ stdio: \["ignore", 2, 2\] \}/u,
  );
  assert.doesNotMatch(environment, /stdio: "inherit"/u);
  assert.match(environment, /node_modules\/@kungfu-tech\/kfd\/package\.json/u);
  assert.match(environment, /\.buildchain\/runtime\/node_modules/u);
  assert.match(environment, /fs\.renameSync\(consumerModules, runtimeModules\)/u);
  assert.match(
    environment,
    /fs\.symlinkSync\([\s\S]*runtimeModules[\s\S]*consumerModules[\s\S]*"dir"/u,
  );
  assert.match(environment, /ACTIONS_ID_TOKEN_REQUEST_URL/u);
  assert.match(environment, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/u);
  assert.match(
    environment,
    /exec corepack pnpm@11\.7\.0 dlx npm@\$\{TRUSTED_PUBLISHING_NPM_VERSION\} "\$@"/u,
  );
  assert.match(
    engine,
    /if \(payload\.inputs\["trusted-publishing"\] === true\)[\s\S]*prepareTrustedPublishingNpm\(\)/u,
  );
});
