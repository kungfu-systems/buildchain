import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("governance audit keeps fork pull requests on a bounded read-only token fallback", () => {
  const auditWorkflow = fs.readFileSync(
    new URL("../.github/workflows/github-governance-audit.yml", import.meta.url),
    "utf8",
  );
  assert.match(auditWorkflow, /actions\/create-github-app-token@v3/);
  assert.match(
    auditWorkflow,
    /name: Mint bounded governance auditor token[\s\S]+KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY != ''[\s\S]+continue-on-error: true/,
  );
  assert.match(
    auditWorkflow,
    /app-id: \$\{\{ vars\.KUNGFU_GOVERNANCE_AUDITOR_APP_ID \}\}/,
  );
  assert.match(
    auditWorkflow,
    /GH_TOKEN: \$\{\{ steps\.auditor\.outputs\.token \|\| github\.token \}\}/,
  );
});
