import { resolveArtifactCoordinate } from "../packages/core/build/artifact-coordinate.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { collectionContainerArguments } from '../packages/core/build/demo/collection-containers.js';
import {demoScenario} from '../packages/core/build/demo/collection-context.js';
import { demoBranchName,establishDemoBranch,materializeDemoCollection,publishDemoPullRequest } from '../packages/core/build/demo/publication.js';
import { qualifyCapturedDemos } from '../packages/core/build/demo/collection.js';
import { scenario,declarePresentation } from './helpers/demo-scenario.mjs';
const sha='a'.repeat(40),renderer=`ghcr.io/acme/renderer@sha256:${'b'.repeat(64)}`;
function workspace(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'buildchain-demo-node-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function writeScenario(root,presentation=false){const value=scenario();if(presentation)declarePresentation(value);fs.mkdirSync(path.join(root,'source/.buildchain'),{recursive:true});fs.writeFileSync(path.join(root,'source/.buildchain/auditable-demo.json'),JSON.stringify(value));return value;}
test('demo containers retain isolation and native capture differences across all six operations',()=>{
 const env={runtimeRoot:'/workspace/.buildchain/runtime',workspace:'/workspace',scenarioPath:'.buildchain/auditable-demo.json',rendererImage:renderer};
 for(const op of ['capture','smoke','inspect-smoke','validate','render','inspect-render']){const args=collectionContainerArguments(env,op,'demo');assert.ok(args.includes('--read-only'));assert.equal(args[args.indexOf('--network')+1],'none');assert.equal(args[args.indexOf('--user')+1],'65532:65532');assert.equal(args[args.indexOf('--pids-limit')+1],'256');assert.ok(args.includes('no-new-privileges'));}
 const smoke=collectionContainerArguments(env,'smoke','demo'),full=collectionContainerArguments(env,'render','demo');assert.ok(!smoke.includes('--terminal-capture'));assert.ok(full.includes('--terminal-capture'));assert.ok(full.includes('--rendition-set'));assert.ok(full.includes('/tmp:rw,noexec,nosuid,size=1g'));assert.ok(collectionContainerArguments(env,'validate','demo').includes('--validate-only'));assert.ok(collectionContainerArguments(env,'capture','demo').includes('/runtime/packages/core/providers/demo/capture-worker.py'));
 assert.throws(()=>collectionContainerArguments({...env,rendererImage:'mutable:latest'},'capture','demo'),/immutable/);assert.throws(()=>collectionContainerArguments(env,'capture','../escape'),/canonical/);
});
test('demo scenario and digest readers reject traversal and malformed coordinate data',t=>{
 const root=workspace(t);writeScenario(root);assert.equal(demoScenario({workspace:root,scenarioPath:'.buildchain/auditable-demo.json'}).scenario.demos.length,2);assert.throws(()=>demoScenario({workspace:root,scenarioPath:'../../escape.json'}),/checked-out source/);
});
test('demo artifact download binding rejects duplicate and expired same-run artifacts',async()=>{
 const artifact={name:'binary',digest:`sha256:${'a'.repeat(64)}`,expired:false};const context={repo:{owner:'acme',repo:'demo'},runId:1};const github={rest:{actions:{listWorkflowRunArtifacts(){}}},paginate:async()=>[artifact,artifact]};const env={EXPECTED_NAME:'binary',EXPECTED_DIGEST:artifact.digest,COORDINATE_PATH:'binary-coordinate.json'};
 await assert.rejects(resolveArtifactCoordinate({name: env.EXPECTED_NAME, digest: env.EXPECTED_DIGEST, sourceSha: sha, runAttempt: "1"}, {github,context}),/exactly one|digest mismatch/);github.paginate=async()=>[{...artifact,expired:true}];await assert.rejects(resolveArtifactCoordinate({name: env.EXPECTED_NAME, digest: env.EXPECTED_DIGEST, sourceSha: sha, runAttempt: "1"}, {github,context}),/exactly one|digest mismatch/);
});
test('demo branch resolution never converts a provider failure into a new branch',t=>{
 const calls=[];assert.throws(()=>establishDemoBranch({workspace:workspace(t),sourceSha:sha},(_,args)=>{calls.push(args);if(args[0]==='ls-remote'){const error=new Error('denied');error.status=128;throw error;}return '';}),error=>error.status===128);assert.ok(!calls.some(args=>args[0]==='switch'));assert.throws(()=>demoBranchName('short'),/exact/);
});
test('demo materialization stages only declared source files and returns an existing PR without a push', async t => {
 const root=workspace(t),value=writeScenario(root,true),request={workspace:root,scenarioPath:'.buildchain/auditable-demo.json',sourceSha:sha,repository:'acme/demo',baseRef:'dev',runtimeSha:sha,rendererImage:renderer};
 const targets=[];materializeDemoCollection(request,args=>targets.push(args));assert.equal(targets.length,2);assert.ok(targets.every(args=>args.repositoryRoot===path.join(root,'source')&&args.captureRoot.startsWith(path.join(root,'.demo-input/captures'))));
 const calls=[];const url=await publishDemoPullRequest(request,{provider:{listOpen:async()=>[{html_url:'https://github.com/acme/demo/pull/1'}]},execute:(program,args,options)=>{calls.push({program,args,options});if(args[0]==='branch')return demoBranchName(sha);return '';}});
 assert.equal(url,'https://github.com/acme/demo/pull/1');const staged=calls.find(call=>call.args[0]==='add');assert.deepEqual(staged.args,['add','--',value.publication.readmePath,value.publication.evidencePath,value.presentation.materialization.technicalSpecPath]);assert.equal(staged.options.cwd,path.join(root,'source'));assert.ok(!calls.some(call=>call.args.includes('config')||call.args.includes('push')));
});
test('advisory render failure preserves Gate qualification and suppresses publication; Gate failures stay fatal', () => {
 const calls=[];
 const result=qualifyCapturedDemos({renderMedia:true,renderFailureAdvisory:true},{qualify:()=>calls.push('gate'),render:()=>{calls.push('render');throw new Error('renderer failed');},onAdvisoryFailure:()=>calls.push('advisory')});
 assert.deepEqual(calls,['gate','render','advisory']);assert.equal(result.renderOutcome,'failure');
 assert.throws(()=>qualifyCapturedDemos({renderMedia:true,renderFailureAdvisory:true},{qualify:()=>{throw new Error('Gate failed');},render:()=>assert.fail('render must not start')}),/Gate failed/u);
 const workflow=YAML.parse(fs.readFileSync('.github/workflows/public-build-demo.yml','utf8'));assert.match(workflow.jobs.publish.if,/needs.qualify.outputs.render-result == 'success'/u);
 const action=YAML.parse(fs.readFileSync('actions/build/demo/qualify/action.yml','utf8'));assert.equal(action.outputs['render-result'].value,'${{ steps.identity.outputs.render-result }}');
 const publisher=YAML.parse(fs.readFileSync('actions/build/demo/publish/action.yml','utf8'));const source=publisher.runs.steps.find(s=>s.name==='Check out exact source with bounded update capability');assert.equal(source.with.path,'source');assert.equal(source.with['persist-credentials'],true);assert.ok(publisher.runs.steps[0].uses.endsWith('/workflow/admission/reject'));
 for(const composite of [action,publisher])for(const step of composite.runs.steps)assert.ok(step.uses&&!step.run&&!step.with?.script);
});
