import assert from "node:assert/strict";
import test from "node:test";
import { selectExecutionRuntimeAction } from "../packages/core/runtime/entry/actions.js";
const sha=c=>c.repeat(40),digest="sha256:"+"d".repeat(64);
const env={GITHUB_REPOSITORY:"consumer/project",GITHUB_SHA:sha("d"),GITHUB_REF:"refs/heads/main",GITHUB_ACTOR:"operator",GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_RUN_ID:"22",GITHUB_WORKFLOW_REF:"consumer/project/.github/workflows/build.yml@refs/heads/main"};
function harness({allowed=true,recovery=false}={}){
 const calls=[];
 const deps={githubFactory:()=>({}),providerFactory:(_github,context)=>({
  authorize:async({origin})=>{calls.push(["authorize",origin]);if(origin==="runtime-parameter"&&!allowed)throw new Error("not authorized");},
  readLock:async file=>{calls.push(["lock",context.sourceSha,file]);return {schemaVersion:1,contract:"kungfu-buildchain-contract-lock",buildchain:{ref:"v4-alpha",resolvedSha:sha("b"),contractDigest:digest}};},
  resolveRef:async()=>{calls.push(["resolve"]);return sha("c");},
  readProtocol:async()=>({schema:"buildchain.runtime-entry/v1",protocol:1}),
  readRun:async()=>({id:11,run_attempt:1,path:".github/workflows/build.yml",status:"completed",conclusion:"failure",repository:{full_name:env.GITHUB_REPOSITORY},head_repository:{full_name:env.GITHUB_REPOSITORY},head_sha:sha("e"),head_branch:"main"}),
 })};
 async function run(values){const outputs={};const inputs={token:"test","workflow-sha":sha("a"),"workflow-ref":"kungfu-systems/buildchain/.github/workflows/build.yml@v4",...values};await selectExecutionRuntimeAction({getInput:name=>inputs[name]||"",setOutput:(name,value)=>outputs[name]=value},env,deps);return outputs;}
 return {run,calls};
}
test("nested workflows transport one resolved train without resolving it again",async()=>{
 const h=harness();const first=await h.run({"runtime-ref":"train/v4/v4.1/repair"});const nested=await h.run({selection:JSON.stringify(first.selection)});
 assert.equal(first.sha,sha("c"));assert.equal(nested.sha,first.sha);
 assert.equal(h.calls.filter(([kind])=>kind==="resolve").length,1);
});
test("nested workflow preserves the outer lock choice and restores lock metadata from its source",async()=>{
 const h=harness();const first=await h.run({"contract-lock":".buildchain/alpha-contract-lock.json"});const transport={...first.selection,ref:"forged",class:"forged",contract:{path:first.selection.contract.path}};
 const nested=await h.run({selection:JSON.stringify(transport)});
 assert.equal(nested.selection.contract.digest,digest);assert.equal(nested.selection.class,"alpha");
 assert.ok(h.calls.filter(([kind])=>kind==="lock").every(([,source,file])=>source===env.GITHUB_SHA&&file===".buildchain/alpha-contract-lock.json"));
});
test("untrusted transport cannot replace the lock-selected execution code",async()=>{
 const h=harness({allowed:false});const first=await h.run({});
 await assert.rejects(h.run({selection:JSON.stringify({...first.selection,sha:sha("f")})}),/not selected/);
 await assert.rejects(h.run({selection:JSON.stringify({...first.selection,origin:"runtime-parameter"})}),/not authorized/);
});
test("a repaired runtime carries the original failed source into nested jobs",async()=>{
 const h=harness();const first=await h.run({"runtime-ref":"train/v4/v4.1/repair","resume-run-id":"11"});const nested=await h.run({selection:JSON.stringify(first.selection)});
 assert.equal(nested["source-sha"],sha("e"));assert.equal(nested.selection.source.runId,"11");assert.equal(h.calls.filter(([kind])=>kind==="resolve").length,1);
});

test("unsafe lock paths fail at entry before any provider read", async () => {
 for (const file of ["../outside.json", "/tmp/lock.json", ".buildchain/../lock.json", ".buildchain\\lock.json"]) {
  const h = harness();
  await assert.rejects(h.run({"contract-lock": file}), /relative|unsafe|path/i);
  assert.equal(h.calls.length, 0);
 }
});
