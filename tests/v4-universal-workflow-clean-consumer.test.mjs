import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
test("the Bootstrap shell prepares a clean release consumer before candidate execution", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/bootstrap.yml", import.meta.url),
    "utf8",
  );
  const setup = workflow.indexOf("name: Set up release-promotion Node.js");
  const install = workflow.indexOf(
    "name: Install release-promotion consumer dependencies",
  );
  const execute = workflow.indexOf("name: Execute candidate engine");
  assert.ok(setup >= 0 && install > setup && execute > install);
  assert.match(
    workflow,
    /capability-id: \$\{\{ steps\.inspect\.outputs\.capability-id \}\}[\s\S]*echo "capability-id=\$\(jq -r '\.capability\.id'/u,
  );
  assert.match(
    workflow,
    /if: \$\{\{ needs\.admit\.outputs\.capability-id == 'release-candidate-promote' \}\}[\s\S]*corepack pnpm@11\.7\.0 install --frozen-lockfile --ignore-scripts/u,
  );
});
test("the exact candidate runtime can prepare an older clean Bootstrap consumer", () => {
  const engine = fs.readFileSync(
    new URL("../scripts/v4-universal-workflow-engine.mjs", import.meta.url),
    "utf8",
  );
  const execute = engine.indexOf("async function executeReleasePromotion");
  assert.ok(
    engine.indexOf(
      "prepareReleasePromotionConsumerDependencies(repository)",
      execute,
    ) < engine.indexOf("resolveReleaseCandidateArtifacts({", execute),
  );
  assert.match(engine, /pnpm@11\.7\.0 install --frozen-lockfile --ignore-scripts/u);
  assert.match(engine, /node_modules\/@kungfu-tech\/kfd\/package\.json/u);
  assert.match(engine, /\.buildchain\/runtime\/node_modules/u);
  assert.match(engine, /fs\.renameSync\(consumerModules, runtimeModules\)/u);
  assert.match(
    engine,
    /fs\.symlinkSync\([\s\S]*runtimeModules[\s\S]*consumerModules[\s\S]*"dir"/u,
  );
});
