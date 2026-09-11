import test from "node:test";
import assert from "node:assert/strict";
import { recoveryTerminalReceipt } from "../packages/core/workflow/admission/recovery.js";
import { contentRoot } from "../packages/core/workflow/engine/identity.js";
import { admitUniversalWorkflow } from "../packages/core/workflow/universal-workflow-bootstrap.js";
import { policy,request,consumerObservation } from "./universal-workflow-harness.mjs";
function fixture(){
 const p=policy();const admission=admitUniversalWorkflow({...consumerObservation(),request:request(p),policy:p,now:"2026-08-30T12:00:00.000Z"});
 const body={schema:"kungfu-buildchain-v4-universal-workflow-result/v1",status:"succeeded",requestRoot:admission.requestRoot,capabilityRoot:admission.capabilityRoot,runtime:admission.runtime,output:{completed:true}};
 return {admission,result:{...body,resultRoot:contentRoot("universal-workflow-result",body)}};
}
test("settlement seals a rooted capability result without runtime readmission",()=>{
 const {admission,result}=fixture();assert.equal(recoveryTerminalReceipt(admission,result).status,"succeeded");
});
for(const key of ["requestRoot","capabilityRoot","output"])test(`settlement rejects ${key} substitution`,()=>{
 const {admission,result}=fixture();result[key]="changed";assert.throws(()=>recoveryTerminalReceipt(admission,result),/root mismatch/);
});
test("a freshly rooted result from another request still fails settlement",()=>{
 const {admission,result}=fixture();result.requestRoot='sha256:'+"a".repeat(64);const {resultRoot,...body}=result;result.resultRoot=contentRoot("universal-workflow-result",body);assert.throws(()=>recoveryTerminalReceipt(admission,result),/admitted lineage/);
});
