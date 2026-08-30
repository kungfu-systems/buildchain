import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
assert.deepEqual(
  contract.retiredWorkflowSurfaces,
  [...new Set(contract.retiredWorkflowSurfaces)].sort(),
  "retired workflow surfaces must be sorted and duplicate-free",
);
for (const relative of contract.retiredWorkflowSurfaces) {
  assert.ok(
    contract.inventoryWorkflows.includes(relative),
    `retired workflow is outside the inventory: ${relative}`,
  );
  assert.match(
    fs.readFileSync(path.join(root, relative), "utf8"),
    /retired/u,
    `retired workflow does not fail closed explicitly: ${relative}`,
  );
}
const activeWorkflows = contract.inventoryWorkflows.filter(
  (relative) =>
    !contract.retiredWorkflowSurfaces.includes(relative) &&
    relative !== contract.bootstrap.consumerRecoveryWorkflow,
);
assert.deepEqual(
  contract.bootstrapGovernedWorkflows,
  activeWorkflows,
  "every active public reusable workflow must be Bootstrap-governed",
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
  contract.capabilityAdapters.map(({ id }) => id).sort(),
  [...admissionPolicy.allowedCapabilities].sort(),
  "every admitted capability must have one real candidate adapter",
);
for (const adapter of contract.capabilityAdapters) {
  assert.match(adapter.execution, /^exact-candidate-/u);
  assert.ok(adapter.payloadSchema.endsWith("/v1"));
}
assert.ok(!admissionPolicy.allowedCapabilities.includes("workflow-contract"));
assert.deepEqual(
  admissionPolicy.contractRoots,
  [
    fileRoot("architecture/v4-universal-workflow-bootstrap.json"),
    fileRoot(contract.bootstrap.faultCampaign),
    fileRoot("packages/core/v4-universal-workflow-bootstrap.js"),
    fileRoot("scripts/v4-universal-workflow-backflow.mjs"),
    fileRoot("scripts/v4-universal-workflow-engine.mjs"),
    fileRoot("scripts/v4-universal-workflow-self-dogfood.mjs"),
  ].sort(),
);
assert.doesNotMatch(
  fs.readFileSync(
    path.join(root, contract.bootstrap.candidateEnginePath),
    "utf8",
  ),
  /request\.capability\.id\s*===\s*["']workflow-contract["']/u,
  "contract-only validation must not be admitted as successful execution",
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
execFileSync(
  process.execPath,
  [path.join(root, contract.migration.compatibilityFacadeGenerator), "--check"],
  { stdio: "inherit" },
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
  /ascii_downcase\) == "kungfu-origin"[\s\S]*\.name == "check"[\s\S]*map\(select\(\.status == "completed" and \(\.conclusion \/\/ ""\) != ""\)\)[\s\S]*candidate\/architecture\/v4-universal-workflow-train-admission\.json/u,
);
const consumerTemplate = fs.readFileSync(
  path.join(root, contract.bootstrap.consumerTemplate),
  "utf8",
);
const consumerRecoveryTemplate = fs.readFileSync(
  path.join(root, contract.bootstrap.consumerRecoveryTemplate),
  "utf8",
);
const consumerRecoveryWorkflow = fs.readFileSync(
  path.join(root, contract.bootstrap.consumerRecoveryWorkflow),
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
assert.match(
  consumerRecoveryTemplate,
  /recovery-admit:[\s\S]*recovery-execute:/u,
);
assert.match(
  consumerRecoveryTemplate,
  /Parse exact recovery coordinates without Buildchain code[\s\S]*Prove exact independent review before candidate code runs[\s\S]*ascii_downcase\) == "kungfu-origin"[\s\S]*\.name == "check"[\s\S]*Admit candidate policy and exact-head checks[\s\S]*map\(select\(\.status == "completed" and \(\.conclusion \/\/ ""\) != ""\)\)/u,
);
assert.match(
  consumerRecoveryTemplate,
  /recovery-execute:[\s\S]*needs: recovery-admit[\s\S]*contents: write/u,
);
assert.doesNotMatch(
  consumerRecoveryTemplate,
  /uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\//u,
  "consumer recovery must not parse any published Buildchain workflow",
);
assert.equal(
  consumerRecoveryWorkflow,
  consumerRecoveryTemplate,
  "the Buildchain self-consumer must exercise the exact distributable recovery shell",
);
assert.match(
  selfDogfood,
  /uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\/bootstrap\.yml@train\/v4\/v4\.0\/universal-reusable-workflow-bootstrap/u,
);
assert.match(
  selfDogfood,
  /uses:\s+\.\/\.github\/workflows\/universal-bootstrap-recovery\.yml/u,
);
assert.doesNotMatch(
  selfDogfood,
  /\.github\/workflows\/bootstrap\.yml@(?:v4|v4-alpha)(?:\s|$)/u,
  "Train self-dogfood must not depend on an alpha or stable Bootstrap tag",
);
for (const channel of ["conformance", "alpha", "stable"]) {
  assert.match(selfDogfood, new RegExp(`primary-${channel}:`, "u"));
  assert.match(selfDogfood, new RegExp(`recovery-${channel}:`, "u"));
}
assert.match(
  selfDogfood,
  /\.state == "APPROVED"[\s\S]*ascii_downcase\) == "kungfu-origin"[\s\S]*\.name == "check"[\s\S]*\.conclusion == "success"/u,
);
assert.match(
  consumerRecoveryTemplate,
  /result-json:[\s\S]*value:\s*\$\{\{ jobs\.recovery-execute\.outputs\.result-json \}\}/u,
);

console.log(
  JSON.stringify({
    ok: true,
    schema: contract.schema,
    publicWorkflowCount: discovered.length,
    activePublicWorkflowCount: activeWorkflows.length,
    retiredWorkflowCount: contract.retiredWorkflowSurfaces.length,
    inventoriedWorkflowCount: contract.inventoryWorkflows.length,
    inventoryCoveragePercent: 100,
    governedWorkflowCount: contract.bootstrapGovernedWorkflows.length,
    governedCoveragePercent: Number(
      (
        (contract.bootstrapGovernedWorkflows.length / activeWorkflows.length) *
        100
      ).toFixed(2),
    ),
    migration: contract.migration,
  }),
);
