import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture/v4-universal-workflow-bootstrap.json"),
    "utf8",
  ),
);
const admissionPolicy = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture/v4-universal-workflow-train-admission.json"),
    "utf8",
  ),
);
const fileRoot = (relative) =>
  `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, relative)))
    .digest("hex")}`;

const workflowRoot = path.join(root, ".github/workflows");
const discovered = fs
  .readdirSync(workflowRoot)
  .filter((name) => /\.ya?ml$/u.test(name))
  .map((name) => `.github/workflows/${name}`)
  .filter((relative) =>
    /(?:^|\n)\s*workflow_call:\s*(?:\n|$)/u.test(
      fs.readFileSync(path.join(root, relative), "utf8"),
    ),
  )
  .sort();

assert.equal(
  contract.schema,
  "kungfu-buildchain-v4-universal-workflow-bootstrap/v1",
);
assert.deepEqual(
  contract.inventoryWorkflows,
  [...new Set(contract.inventoryWorkflows)].sort(),
  "inventoried public workflows must be sorted and duplicate-free",
);
assert.deepEqual(
  contract.inventoryWorkflows,
  discovered,
  "every active public workflow_call surface must be inventoried",
);
for (const relative of contract.inventoryWorkflows)
  assert.ok(
    fs.statSync(path.join(root, relative)).isFile(),
    `inventoried workflow is unavailable: ${relative}`,
  );
assert.deepEqual(
  contract.bootstrapGovernedWorkflows,
  [...new Set(contract.bootstrapGovernedWorkflows)].sort(),
  "Bootstrap-governed workflows must be sorted and duplicate-free",
);
for (const relative of contract.bootstrapGovernedWorkflows) {
  assert.ok(
    contract.inventoryWorkflows.includes(relative),
    `Bootstrap-governed workflow is outside the inventory: ${relative}`,
  );
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  assert.ok(
    relative === contract.bootstrap.publicWorkflow ||
      /uses:\s+(?:\.\/)?\.github\/workflows\/bootstrap\.yml/u.test(source) ||
      /uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\/bootstrap\.yml@/u.test(
        source,
      ),
    `workflow is declared governed without a Bootstrap edge: ${relative}`,
  );
}

assert.deepEqual(contract.complexityBudget, {
  bootstrapAbis: 1,
  requestEnvelopes: 1,
  candidateResolvers: 1,
  candidateEngines: 1,
  terminalReceiptAuthorities: 1,
  perWorkflowBootstrapImplementations: 0,
  buildchainOnlySelfReleasePaths: 0,
  perIncidentConsumerEdits: 0,
});
assert.equal(contract.bootstrap.discoveryRefExecutionAuthority, false);
assert.equal(contract.bootstrap.exactShaExecutionAuthority, true);
assert.equal(contract.bootstrap.consumerSourceMutationPerIncident, false);
assert.equal(contract.bootstrap.buildchainReleasePromotionPerIncident, false);
assert.equal(contract.bootstrap.selfDogfoodUsesPublicContract, true);
assert.equal(contract.bootstrap.recoveryDependsOnPublishedBuildchain, false);
assert.deepEqual(
  admissionPolicy.contractRoots,
  [
    fileRoot("architecture/v4-universal-workflow-bootstrap.json"),
    fileRoot("packages/core/v4-universal-workflow-bootstrap.js"),
    fileRoot("scripts/v4-universal-workflow-engine.mjs"),
  ].sort(),
);
const bootstrapSource = fs.readFileSync(
  path.join(root, contract.bootstrap.publicWorkflow),
  "utf8",
);
assert.doesNotMatch(
  bootstrapSource,
  /admission-policy-json:/u,
  "callers must not supply their own admission authority",
);
assert.match(
  bootstrapSource,
  /admit:[\s\S]*checks: read[\s\S]*pull-requests: read/u,
);
assert.match(
  bootstrapSource,
  /execute:[\s\S]*needs: admit[\s\S]*contents: write/u,
);
assert.match(bootstrapSource, /settle:[\s\S]*needs: \[admit, execute\]/u);
assert.match(
  bootstrapSource,
  /candidate\/architecture\/v4-universal-workflow-train-admission\.json/u,
);
const consumerTemplate = fs.readFileSync(
  path.join(root, contract.bootstrap.consumerTemplate),
  "utf8",
);
const selfDogfood = fs.readFileSync(
  path.join(root, contract.bootstrap.selfDogfoodWorkflow),
  "utf8",
);
assert.match(
  consumerTemplate,
  /uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\/bootstrap\.yml@v4/u,
);
assert.match(consumerTemplate, /recovery-admit:[\s\S]*recovery-execute:/u);
assert.match(
  consumerTemplate,
  /Parse exact recovery coordinates without Buildchain code[\s\S]*Prove exact independent review before candidate code runs/u,
);
assert.match(
  consumerTemplate,
  /recovery-execute:[\s\S]*needs: recovery-admit[\s\S]*contents: write/u,
);
assert.match(
  selfDogfood,
  /uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\/bootstrap\.yml@v4-alpha/u,
);
assert.doesNotMatch(
  selfDogfood,
  /uses:\s+\.\/\.github\/workflows\/bootstrap\.yml/u,
  "self-dogfood must not use a repository-local Bootstrap bypass",
);

console.log(
  JSON.stringify({
    ok: true,
    schema: contract.schema,
    publicWorkflowCount: discovered.length,
    inventoriedWorkflowCount: contract.inventoryWorkflows.length,
    inventoryCoveragePercent: 100,
    governedWorkflowCount: contract.bootstrapGovernedWorkflows.length,
    governedCoveragePercent: Number(
      (
        (contract.bootstrapGovernedWorkflows.length / discovered.length) *
        100
      ).toFixed(2),
    ),
    migration: contract.migration,
  }),
);
