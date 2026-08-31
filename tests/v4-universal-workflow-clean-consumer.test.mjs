import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("real release promotion prepares a clean consumer before candidate execution", () => {
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
