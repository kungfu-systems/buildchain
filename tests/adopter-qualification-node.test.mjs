import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {adopterSelection,adopterInputFile,verifyAdopterCheckouts} from '../packages/core/adoption/nodes/qualification.mjs';
import {createCrossPlatformAdopterReport,qualifyCrossPlatformAdopters,CROSS_PLATFORM_ADOPTER_PLATFORMS} from '../packages/core/adoption/cross-platform-adopter-qualification.js';
const sha='a'.repeat(40),root='sha256:'+'b'.repeat(64);
test('adopter rejects partial external selection and unsafe identities before checkout',()=>{
 const base={GITHUB_SHA:sha,GITHUB_REPOSITORY:'org/self',BUILDCHAIN_WORKFLOW_SHA:sha};
 for(const input of [{consumer:'demo','consumer-repository':'org/other'},{consumer:'../bad'},{consumer:'demo','consumer-repository':'org/other','consumer-ref':'main','invocation-source-path':'.github/workflows/build.yml'}])assert.throws(()=>adopterSelection({...base,BUILDCHAIN_ADOPTER_REQUEST_JSON:JSON.stringify(input)},()=>{}),/External adopter|stable lowercase/);
 assert.deepEqual(adopterSelection({...base,BUILDCHAIN_ADOPTER_REQUEST_JSON:'{"consumer":"demo"}'},()=>{}),{repository:'org/self',sha});
});
test('adopter files reject traversal and symlink substitution',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'adopter-file-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.mkdirSync(path.join(directory,'consumer'));fs.writeFileSync(path.join(directory,'outside.json'),'{}');fs.symlinkSync(path.join(directory,'outside.json'),path.join(directory,'consumer/input.json'));
 for(const name of ['../outside.json','input.json'])assert.throws(()=>adopterInputFile(path.join(directory,'consumer'),name),/relative|escapes/);
});
test('adopter checks both immutable runtime and admitted consumer',()=>{
 const env={GITHUB_WORKSPACE:'/workspace',BUILDCHAIN_WORKFLOW_SHA:sha,BUILDCHAIN_CONSUMER_SHA:sha,BUILDCHAIN_ADOPTER_REQUEST_JSON:'{}'};let calls=0;
 assert.throws(()=>verifyAdopterCheckouts(env,()=>++calls===1?sha:'c'.repeat(40)),/drifted/);assert.equal(calls,2);
});
function report(platform,change={}){
 return createCrossPlatformAdopterReport({platform,consumer:'demo',sourceBinding:{runtimeSha:sha,consumerSha:sha,inputRoot:root,...change},execution:{initialRun:{status:'passed',readbackRoot:root},tamperFailure:{status:'failed-as-required',exitCode:1},retryRun:{status:'passed',readbackRoot:root},terminalVerify:{status:'passed',readbackRoot:root},neutralDriver:{id:'ledger-specification-driver',status:'passed',kfdDependencyPresent:false}},authority:{productionWrites:false,providerEffects:false,releaseEffects:false,stablePublication:false}});
}
test('aggregation rejects consumer SHA or declaration drift across platforms and duplicate reports',()=>{
 for(const change of [{consumerSha:'c'.repeat(40)},{inputRoot:'sha256:'+'c'.repeat(64)}])assert.throws(()=>qualifyCrossPlatformAdopters({reports:CROSS_PLATFORM_ADOPTER_PLATFORMS.map((p,i)=>report(p,i===2?change:{})),consumers:['demo']}),/same exact source and input/);
 const reports=CROSS_PLATFORM_ADOPTER_PLATFORMS.map(p=>report(p));assert.throws(()=>qualifyCrossPlatformAdopters({reports:[...reports,reports[0]],consumers:['demo']}),/duplicate/);
 const result=qualifyCrossPlatformAdopters({reports,consumers:['demo']});assert.equal(result.reports.length,3);assert.equal(result.authority.productionWrites,false);assert.equal(Object.hasOwn(result,'capabilityMatrix'),false);
});
