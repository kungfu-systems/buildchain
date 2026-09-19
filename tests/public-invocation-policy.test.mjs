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
test('self normal and recovery callers expose only their generated public inputs',()=>{
 const normal=YAML.parse(fs.readFileSync('.github/workflows/buildchain.yml','utf8'));
 const recovery=YAML.parse(fs.readFileSync('.github/workflows/buildchain-recover.yml','utf8'));
 assert.equal(normal.jobs.buildchain.uses,'kungfu-systems/buildchain/.github/workflows/public-ops-pipeline.yml@v4-alpha');
 assert.equal(recovery.jobs.buildchain.uses,'kungfu-systems/buildchain/.github/workflows/public-ops-recover.yml@v4-alpha');
 assert.deepEqual(Object.keys(normal.jobs.buildchain.with),['config-path']);
 assert.deepEqual(Object.keys(recovery.jobs.buildchain.with),['attempt','runtime-ref']);
});
