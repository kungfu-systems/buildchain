import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import { auditRuntimeEntry } from "./check-runtime-entry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const json = file => JSON.parse(read(file));
const parse = file => YAML.parse(read(file));
const contract = json("architecture/universal-workflow-bootstrap.json");
const policy = json("architecture/universal-workflow-capability-policy.json");
const files = fs.readdirSync(path.join(root, ".github/workflows")).filter(f => /\.ya?ml$/u.test(f)).map(f => `.github/workflows/${f}`);
const reusable = files.filter(f => parse(f).on?.workflow_call).sort();
assert.deepEqual(contract.inventoryWorkflows, reusable, "Every reusable API must have an owner");
assert.deepEqual([...contract.directCapabilityWorkflows, ...contract.bootstrapGovernedWorkflows].sort(), reusable, "Capabilities and bootstrap must partition the APIs");
assert.equal(contract.bootstrap.runtimeEntry, "architecture/runtime-entry.json");
assert.equal(contract.bootstrap.runtimeRecovery, "same-public-entry-with-transient-runtime");
assert.equal(contract.bootstrap.entryRecovery, "upgrade-public-entry-and-full-rerun");
assert.deepEqual(auditRuntimeEntry(root).issues, []);
for (const retired of ["templates/bootstrap-recovery", "templates/universal-buildchain-bootstrap-recovery.yml", ".github/workflows/public-ops-bootstrap-recovery.yml"])
  assert.equal(fs.existsSync(path.join(root, retired)), false, `Copied recovery code must remain retired: ${retired}`);
assert.deepEqual(contract.capabilityAdapters.map(a => a.id).sort(), [...policy.allowedCapabilities].sort());
assert.ok(!policy.allowedCapabilities.includes("workflow-contract"), "Validation alone is not capability execution");
const now = Date.now();
assert.ok(now >= Date.parse(policy.validFrom) && now < Date.parse(policy.expiresAt), "Capability admission policy requires protected renewal");
assert.deepEqual(policy.contractRoots, contract.bootstrap.admissionPolicySources.map(f => `sha256:${crypto.createHash("sha256").update(read(f)).digest("hex")}`).sort());
const workflow = parse(contract.bootstrap.publicWorkflow);
assert.deepEqual(Object.keys(workflow.jobs), ["execution-runtime", "admit", "execute", "settle"]);
for (const phase of ["admit", "execute", "settle"]) {
  const job = workflow.jobs[phase];
  assert.ok(job.needs.includes("execution-runtime"));
  assert.ok(job.steps.some(s => s.uses === `./.buildchain/runtime/actions/workflow/bootstrap/${phase}`));
  assert.ok(job.steps.every(s => s.uses && !s.run && !s.shell));
}
assert.ok(workflow.jobs.execute.needs.includes("admit"));
assert.ok(workflow.jobs.settle.needs.includes("execute"));
const executor = parse("actions/workflow/bootstrap/execute/action.yml").runs.steps.find(s => s.id === "execute");
assert.equal(executor.with["mutation-token"], "${{ inputs.secrets-buildchain-promotion-token }}");
assert.equal(executor.with.token, "${{ github.token }}");
assert.doesNotMatch(read(contract.bootstrap.publicWorkflow), /admission-policy-json:/u);
const template = parse(contract.bootstrap.consumerTemplate);
assert.equal(template.jobs.bootstrap.uses, "kungfu-systems/buildchain/.github/workflows/public-ops-bootstrap.yml@v4");
assert.equal(template.jobs.bootstrap.with["runtime-ref"], "${{ inputs.runtime-ref }}");
const dogfood = parse(contract.bootstrap.selfDogfoodWorkflow);
for (const channel of ["conformance", "alpha", "stable"]) for (const mode of ["primary", "recovery"]) {
  const job = dogfood.jobs[`${mode}-${channel}`];
  assert.equal(job.uses, "kungfu-systems/buildchain/.github/workflows/public-ops-bootstrap.yml@v4");
  assert.equal(job.with["runtime-ref"], mode === "primary" ? "${{ inputs.runtime-ref }}" : "${{ inputs.recovery-runtime-ref }}");
}
console.log(JSON.stringify({ ok: true, reusableWorkflowCount: reusable.length, runtimeAcquisitionOwners: 1 }));
