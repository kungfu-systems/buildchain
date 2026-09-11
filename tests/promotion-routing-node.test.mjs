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
 const request={schema:'buildchain.promotion-request/v1','target-ref':'alpha/v4/v4.1',...change};
 return {request, workflowSha:sha,workflowRef:'kungfu-systems/buildchain/.github/workflows/public-release-promote.yml@refs/tags/v4',context:{ref:'refs/heads/alpha/v4/v4.1'},runtime:{repository:'kungfu-systems/buildchain',sha:other,ref:'train/v4/v4.1/repair',origin:'runtime-parameter',contract:{path:'.buildchain/contract-lock.json'}}};
}
test('promotion uses the selected train for every publication channel without resolving it again',async()=>{
 for(const target of ['alpha/v4/v4.1','release/v4/v4.1','publish-gate/major']){
  const result=await routePromotion(fixture({'target-ref':target}));
  assert.equal(result['router-sha'],sha);assert.equal(result['runtime-sha'],other);assert.equal(result['runtime-ref'],'train/v4/v4.1/repair');assert.equal(result['override-used'],'true');
 }
});
test('promotion rejects retired secondary runtime selectors and invalid product targets',async()=>{
 for(const change of [{'buildchain-ref':other},{'resume-buildchain-runtime-sha':other},{'buildchain-repository':'evil/tooling'}])await assert.rejects(()=>routePromotion(fixture(change)),/Unsupported promotion request field/);
 await assert.rejects(()=>routePromotion(fixture({'target-ref':'major-gate'})),/unsupported promotion/);
});
test('promotion lock binding rejects symlink escape and checkout drift before emitting evidence',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'promotion-bind-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'.buildchain/source'),{recursive:true});fs.writeFileSync(path.join(root,'outside.json'),'{}');fs.symlinkSync(path.join(root,'outside.json'),path.join(root,'.buildchain/source/lock.json'));
 const input={workspace:root,sourceSha:sha,request:{},selection:{'contract-lock-path':'lock.json','shell-sha':sha,'runtime-sha':sha,channel:'alpha'}};
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
  assert.ok(wf.jobs[job].steps.some(s=>s.uses==='$/actions/runtime/environment/prepare'));
 }
 assert.equal(wf.jobs.invoke.uses,'./.github/workflows/.release-promote.yml');
});
