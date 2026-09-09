import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("governance audit keeps fork pull requests on a bounded read-only token fallback", () => {
  const auditWorkflow = fs.readFileSync(
    new URL("../actions/governance/audit/action.yml", import.meta.url),
    "utf8",
  );
  assert.match(auditWorkflow, /actions\/create-github-app-token@v3/);
  assert.match(
    auditWorkflow,
    /name: Mint bounded governance auditor token[\s\S]+inputs\.auditor-private-key != ''[\s\S]+continue-on-error: true/,
  );
  assert.match(
    auditWorkflow,
    /app-id: \$\{\{ inputs\.auditor-app-id \}\}/,
  );
  assert.match(
    auditWorkflow,
    /GH_TOKEN: \$\{\{ steps\.auditor\.outputs\.token \|\| inputs\.governance-read-token \|\| github\.token \}\}/,
  );
  assert.match(auditWorkflow, /FORK_PULL_REQUEST:/);
  assert.match(fs.readFileSync(new URL("../packages/core/governance/audit/enforce.mjs", import.meta.url), "utf8"), /credential-limited/);
});
