import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {scanFloatingConsumerPolicy,verifyFloatingConsumerPolicyReceipt} from '../packages/core/consumer/floating-consumer-policy.js';
const workflow='.github/workflows/public-release-promote.yml',digest='sha256:'+'d'.repeat(64);
const policy=JSON.parse(fs.readFileSync('architecture/floating-consumer-policy.json','utf8'));
function fixture(t,repository){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-invocation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'.github/workflows'),{recursive:true});fs.mkdirSync(path.join(root,'.buildchain'));
 for(const [ref,name]of[['v4','contract-lock'],['v4-alpha','alpha-contract-lock']])fs.writeFileSync(path.join(root,`.buildchain/${name}.json`),JSON.stringify({schemaVersion:1,contract:'kungfu-buildchain-contract-lock',buildchain:{ref,resolvedSha:'a'.repeat(40),contractDigest:digest,compatibilityDigest:digest,majorLine:'v4',surfaces:[]}}));
 const caller=path.join(root,'.github/workflows/release.yml');
 function scan(uses=`kungfu-systems/buildchain/${workflow}@v4`,options={}){fs.writeFileSync(caller,YAML.stringify({jobs:{promote:{uses}}}));return scanFloatingConsumerPolicy({root,repository,sourceSha:'b'.repeat(40),invokedWorkflow:workflow,invocationSourcePath:'.github/workflows/release.yml',resolvedWorkflowSha:'c'.repeat(40),resolvedRuntimeSha:'e'.repeat(40),policy,scannerRoot:digest,...options});}
 return {root,scan};
}
for(const repository of ['kungfu-systems/buildchain','consumer/project'])test(`${repository} uses the same public entry independently from selected runtime`,t=>{
 const f=fixture(t,repository),result=f.scan();assert.equal(result.ok,true,JSON.stringify(result.failures));assert.equal(result.receipt.invocation.selectorClass,'floating');assert.equal(verifyFloatingConsumerPolicyReceipt({receipt:result.receipt,receiptRoot:result.receiptRoot}).ok,true);
 for(const uses of [`./${workflow}`,`kungfu-systems/buildchain/${workflow}@${'a'.repeat(40)}`,`kungfu-systems/buildchain/${workflow}@train/v4/v4.1/repair`])assert.equal(f.scan(uses).ok,false,uses);
 fs.unlinkSync(path.join(f.root,'.buildchain/alpha-contract-lock.json'));assert.equal(f.scan().ok,false);
});
test('all self promotion callers use the same public API with a separate runtime parameter',()=>{
 for(const file of ['self-release-promote','self-release-tail-dogfood','self-ops-promotion-recovery']){
  const wf=YAML.parse(fs.readFileSync(`.github/workflows/${file}.yml`,'utf8'));
  const callers=Object.values(wf.jobs).filter(job=>job.uses===`kungfu-systems/buildchain/${workflow}@v4`);
  assert.equal(callers.length,1,file);assert.ok(callers[0].with['request-json']);
  assert.ok(Object.keys(callers[0].with).every(k=>['request-json','runtime-ref','contract-lock','runtime-selection'].includes(k)));
 }
});
