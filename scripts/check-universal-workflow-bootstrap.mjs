import assert from "node:assert/strict";
import YAML from "yaml";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  fs.readFileSync(path.join(root, "architecture/universal-workflow-bootstrap.json"), "utf8"),
);
const admissionPolicy = JSON.parse(
  fs.readFileSync(path.join(root, "architecture/universal-workflow-train-admission.json"), "utf8"),
);
const admissionObservedAt = Date.now();
assert.ok(
  admissionObservedAt >= Date.parse(admissionPolicy.validFrom) &&
    admissionObservedAt < Date.parse(admissionPolicy.expiresAt),
  `release admission policy is outside its validity window (${admissionPolicy.validFrom} to ${admissionPolicy.expiresAt}); renew it through protected review before publishing`,
);
const fileRoot = (relative) =>
  `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, relative)))
    .digest("hex")}`;

const workflowRoot = path.join(root, ".github/workflows");
const discovered = fs.readdirSync(workflowRoot)
  .filter((name) => /\.ya?ml$/u.test(name))
  .map((name) => ({ path: `.github/workflows/${name}`, text: fs.readFileSync(path.join(workflowRoot, name), "utf8") }))
  .filter((entry) => /(?:^|\n)\s*workflow_call:\s*(?:\n|$)/u.test(entry.text))
  .map((entry) => entry.path).sort();

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
assert.equal(Object.hasOwn(contract, "migration"), false, "no historical facade regeneration authority");
assert.equal(Object.hasOwn(contract, "retiredWorkflowSurfaces"), false, "retired workflows must be absent");
const activeWorkflows = contract.inventoryWorkflows;
assert.deepEqual(contract.bootstrapGovernedWorkflows, [contract.bootstrap.publicWorkflow]);
assert.deepEqual(contract.directCapabilityWorkflows, discovered.filter((relative) =>
  relative !== contract.bootstrap.publicWorkflow && relative !== contract.bootstrap.consumerRecoveryWorkflow));
for (const relative of contract.directCapabilityWorkflows) {
  assert.doesNotMatch(fs.readFileSync(path.join(root, relative), "utf8"), /universal-request-json|universal-bootstrap:/u,
    `${relative}: use the independent Bootstrap API instead of a dual execution path`);
}
assert.deepEqual(contract.configurationGovernedWorkflows, [
  ".github/workflows/.build.yml", ".github/workflows/build.yml",
]);
for (const relative of contract.configurationGovernedWorkflows) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const inputBlock = source.split("    inputs:\n")[1].split("    secrets:\n")[0];
  assert.deepEqual([...inputBlock.matchAll(/^      ([a-z0-9-]+):$/gmu)].map((match) => match[1]), ["config-path"]);
  assert.doesNotMatch(source, /universal-request-json/u);
}
for (const relative of contract.bootstrapGovernedWorkflows) {
  assert.ok(
    contract.inventoryWorkflows.includes(relative),
    `Bootstrap-governed workflow is outside the inventory: ${relative}`,
  );
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  assert.ok(
    relative === contract.bootstrap.publicWorkflow ||
      /uses:\s+(?:\.\/)?\.github\/workflows\/public-ops-bootstrap\.yml/u.test(source) ||
      /uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\/public-ops-bootstrap\.yml@/u.test(
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
assert.equal(
  contract.bootstrap.reviewRuntimeBinding,
  "reviewed-head-or-protected-alpha-merge-to-exact-runtime",
);
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
  contract.bootstrap.admissionPolicySources.map(fileRoot).sort(),
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
assert.doesNotMatch(bootstrapSource, /^    permissions:/mu);
const parse = (relative) => YAML.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const bootstrap = YAML.parse(bootstrapSource);
assert.deepEqual(bootstrap.jobs.settle.needs, ["admit", "execute"]);
const execute = parse("actions/workflow/bootstrap-execute/action.yml");
const executor = execute.runs.steps.find((step) => step.id === "execute");
assert.equal(executor.env.BUILDCHAIN_PROMOTION_TOKEN, "${{ inputs.secrets-buildchain-promotion-token }}");
assert.equal(executor.env.GH_TOKEN, "${{ github.token }}");
const recovery = parse(contract.bootstrap.consumerRecoveryTemplate);
assert.deepEqual(Object.keys(recovery.jobs), ["recovery-admit", "recovery-execute", "recovery-settle"]);
assert.equal(recovery.jobs["recovery-execute"].needs, "recovery-admit");
assert.equal(recovery.jobs["recovery-execute"].permissions.contents, "write");
assert.equal(recovery.on.workflow_call.outputs["result-json"].value, "${{ jobs.recovery-execute.outputs.result-json }}");
for (const [id, job] of Object.entries(recovery.jobs)) {
  assert.ok(job.steps.length <= 3, `${id}: recovery workflow contains implementation details`);
  const node = job.steps.find((step) => step.id === "node");
  assert.equal(node.uses, `./.buildchain/workflow-shell/.buildchain/bootstrap-recovery/actions/workflow/bootstrap-${id}`);
  for (const step of job.steps) {
    assert.equal(Object.hasOwn(step, "run"), false, "Recovery workflow must dispatch owned nodes");
    assert.ok(!step.uses?.startsWith("kungfu-systems/buildchain/"), "Recovery cannot depend on published Buildchain");
  }
}
const recoveryAdmit = parse("actions/workflow/bootstrap-recovery-admit/action.yml").runs.steps;
const reviewIndex = recoveryAdmit.findIndex((step) => /independent review/.test(step.name || ""));
const installationIndex = recoveryAdmit.findIndex((step) => step.uses?.endsWith("actions/runtime/prepare"));
const admissionIndex = recoveryAdmit.findIndex((step) => step.id === "admit");
assert.ok(reviewIndex >= 0 && installationIndex > reviewIndex && admissionIndex > installationIndex,
  "No candidate dependency or code may execute before independent review");
execFileSync(process.execPath, [path.join(root, "scripts/generate-bootstrap-recovery.mjs"), "--check"], { cwd: root, stdio: "pipe" });
const primaryTemplate = parse(contract.bootstrap.consumerTemplate);
assert.ok(Object.values(primaryTemplate.jobs).some((job) => job.uses === "kungfu-systems/buildchain/.github/workflows/public-ops-bootstrap.yml@v4"));
const selfDogfood = parse(contract.bootstrap.selfDogfoodWorkflow);
for (const channel of ["conformance", "alpha", "stable"]) {
  assert.equal(selfDogfood.jobs[`primary-${channel}`].uses, "./.github/workflows/public-ops-bootstrap.yml");
  assert.equal(selfDogfood.jobs[`recovery-${channel}`].uses, "./.github/workflows/public-ops-bootstrap-recovery.yml");
}

console.log(
  JSON.stringify({
    ok: true,
    schema: contract.schema,
    publicWorkflowCount: discovered.length,
    activePublicWorkflowCount: activeWorkflows.length,
    inventoriedWorkflowCount: contract.inventoryWorkflows.length,
    inventoryCoveragePercent: 100,
    governedWorkflowCount: contract.bootstrapGovernedWorkflows.length,
    governedCoveragePercent: Number(
      (
        (contract.bootstrapGovernedWorkflows.length / activeWorkflows.length) *
        100
      ).toFixed(2),
    ),
  }),
);
