import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {routePromotion} from '../packages/core/release/promotion/routing.js';
import {bindPromotionSelection} from '../packages/core/release/promotion/selection.js';
const sha='a'.repeat(40), other='b'.repeat(40);
function fixture(change={}) {
 const request={schema:'buildchain.promotion-request/v1','buildchain-repository':'kungfu-systems/buildchain','target-ref':'alpha/v4/v4.1','buildchain-channel':'auto',...change};
 return {request,workflowRepository:'kungfu-systems/buildchain',workflowSha:sha,workflowRef:'kungfu-systems/buildchain/.github/workflows/public-release-promote.yml@refs/heads/dev/v4/v4.1',packageVersion:'4.1.0-alpha.0',context:{eventName:'push',repo:{owner:'kungfu-systems',repo:'buildchain'},ref:'refs/heads/alpha/v4/v4.1'},core:{setOutput(){}},github:{rest:{repos:{getCommit:async()=>{throw Error('unexpected provider resolution');}}}}};
}
test('promotion defaults bind the entire implementation to the defining commit without published alpha',async()=>{
 const result=await routePromotion(fixture());assert.equal(result['router-sha'],sha);assert.equal(result['shell-sha'],sha);assert.equal(result['runtime-sha'],sha);assert.equal(result['override-used'],'false');
});
test('promotion rejects stale-major selectors, repository substitution and untrusted override before checkout',async()=>{
 for(const requested of ['v3','train/v3/v3.0/old','../escape',other])await assert.rejects(()=>routePromotion(fixture({'buildchain-ref':requested})),/authority|trusted workflow_dispatch/);
 await assert.rejects(()=>routePromotion(fixture({'buildchain-repository':'evil/tooling'})),/defining workflow repository/);
 await assert.rejects(()=>routePromotion(fixture({'target-ref':'major-gate'})),/unsupported promotion/);
});
test('an explicit current floating runtime resolves once while the publisher component stays exact',async()=>{
 const f=fixture({'buildchain-ref':'v4-alpha'});let calls=0;f.github.rest.repos.getCommit=async()=>{calls++;return {data:{sha:other}};};
 const result=await routePromotion(f);assert.equal(calls,1);assert.equal(result['runtime-sha'],other);assert.equal(result['shell-sha'],sha);
});
test('resume identity compares the selected tooling runtime and rejects a different exact SHA',async()=>{
 await assert.rejects(()=>routePromotion(fixture({'resume-candidate-run-id':'1','resume-buildchain-runtime-sha':other})),/Recovery runtime/);
});
test('promotion lock binding rejects symlink escape and checkout drift before emitting evidence',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'promotion-bind-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'.buildchain/source'),{recursive:true});fs.writeFileSync(path.join(root,'outside.json'),'{}');fs.symlinkSync(path.join(root,'outside.json'),path.join(root,'.buildchain/source/lock.json'));
 const input={workspace:root,sourceSha:sha,request:{'buildchain-contract-lock-path':'lock.json'},selection:{'shell-sha':sha,'runtime-sha':sha,channel:'alpha'}};
 assert.throws(()=>bindPromotionSelection(input,()=>other),/checked-out commit/);
 assert.throws(()=>bindPromotionSelection(input,()=>sha),/escapes consumer/);
 fs.unlinkSync(path.join(root,'.buildchain/source/lock.json'));fs.writeFileSync(path.join(root,'.buildchain/source/lock.json'),'{}');
 assert.match(bindPromotionSelection(input,()=>sha)['contract-lock-digest'],/^sha256:[a-f0-9]{64}$/);
});
test('generated public router binds every node output and uses declared runtime preparation inputs',()=>{
 const wf=YAML.parse(fs.readFileSync('.github/workflows/public-release-promote.yml','utf8'));
 for(const [job,name] of [['resolve-promotion','resolve'],['consumer-admission','admit']]){
  const action=YAML.parse(fs.readFileSync(`actions/release/promotion/${name}/action.yml`,'utf8'));
  for(const value of Object.values(wf.jobs[job].outputs)){const key=value.match(/steps\.node\.outputs\.([\w-]+)/)[1];assert.ok(action.outputs[key],key);}
  for(const step of action.runs.steps.filter(s=>s.uses?.endsWith('/actions/runtime/environment/prepare')))assert.deepEqual(Object.keys(step.with),['directory']);
 }
 assert.equal(wf.jobs.invoke.uses,'./.github/workflows/.release-promote.yml');
});
