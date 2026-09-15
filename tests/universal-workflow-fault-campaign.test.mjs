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
  if(fault.retired){ assert.equal(fs.existsSync(path.join(root,fault.injectionTarget)),false); assert.ok(fault.retirementReason); continue; }
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
test("self recovery retains the attempt and permits only a transient repaired runtime",()=>{
 const workflow=YAML.parse(read(".github/workflows/buildchain-recover.yml"));
 assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs),["attempt","runtime-ref"]);
 assert.equal(workflow.jobs.buildchain.with.attempt,"${{ inputs.attempt }}");
 assert.equal(workflow.jobs.buildchain.with["runtime-ref"],"${{ inputs.runtime-ref }}");
 assert.equal(workflow.jobs.buildchain.uses,"kungfu-systems/buildchain/.github/workflows/public-ops-recover.yml@v4-alpha");
});
