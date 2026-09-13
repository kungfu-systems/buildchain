import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
const root=path.resolve(import.meta.dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const campaign=JSON.parse(read("architecture/universal-workflow-fault-campaign.json"));
test("entry and runtime faults have the two declared recovery routes",()=>{
 assert.equal(campaign.independentFaultsOnly,true);
 assert.equal(campaign.externalBoundary.recovered,false);
 for(const fault of campaign.faults){
  assert.ok(read(fault.injectionTarget));assert.ok(read(fault.recoveryTarget));
  const runtime=fault.injectionTarget.startsWith("packages/")||fault.injectionTarget.startsWith("actions/");
  assert.equal(fault.recoveryRoute,runtime?"same-entry-transient-runtime":"upgrade-entry-and-full-rerun",fault.id);
 }
});
test("consumer recovery uses the same public entry without a copied distribution",()=>{
 const template=YAML.parse(read("templates/universal-buildchain-bootstrap.yml"));
 assert.equal(template.jobs.bootstrap.uses,"kungfu-systems/buildchain/.github/workflows/public-ops-bootstrap.yml@v4");
 assert.equal(template.jobs.bootstrap.with["runtime-ref"],"${{ inputs.runtime-ref }}");
 for(const file of ["templates/bootstrap-recovery","templates/universal-buildchain-bootstrap-recovery.yml",".github/workflows/public-ops-bootstrap-recovery.yml"])
  assert.equal(fs.existsSync(path.join(root,file)),false,file);
});
test("dogfood exercises primary and repaired runtimes through the identical API",()=>{
 const workflow=YAML.parse(read(".github/workflows/self-ops-bootstrap-dogfood.yml"));
 for(const channel of ["alpha","stable","conformance"]){
  const primary=workflow.jobs[`primary-${channel}`],recovery=workflow.jobs[`recovery-${channel}`];
  assert.equal(primary.uses,recovery.uses);
  assert.equal(primary.with["runtime-ref"],"${{ inputs.runtime-ref }}");
  assert.equal(recovery.with["runtime-ref"],"${{ inputs.recovery-runtime-ref }}");
 }
});
