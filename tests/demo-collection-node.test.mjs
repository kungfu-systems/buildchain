import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { collectionContainerArguments } from '../packages/core/build/nodes/demo-collection-container.mjs';
import demoArtifactCoordinate,{demoScenario,normalizedDemoDigest} from '../packages/core/build/nodes/demo-collection-io.mjs';
import { demoBranchName,establishDemoBranch,materializeDemoCollection,publishDemoPullRequest } from '../packages/core/build/nodes/demo-publication.mjs';
import { scenario,declarePresentation } from './helpers/demo-scenario.mjs';
const sha='a'.repeat(40),renderer=`ghcr.io/acme/renderer@sha256:${'b'.repeat(64)}`;
function workspace(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'buildchain-demo-node-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function writeScenario(root,presentation=false){const value=scenario();if(presentation)declarePresentation(value);fs.mkdirSync(path.join(root,'source/.buildchain'),{recursive:true});fs.writeFileSync(path.join(root,'source/.buildchain/auditable-demo.json'),JSON.stringify(value));return value;}
test('demo containers retain isolation and native capture differences across all six operations',()=>{
 const env={GITHUB_WORKSPACE:'/workspace',SCENARIO_PATH:'.buildchain/auditable-demo.json',RENDERER_IMAGE:renderer};
 for(const op of ['capture','smoke','inspect-smoke','validate','render','inspect-render']){const args=collectionContainerArguments(env,op,'demo');assert.ok(args.includes('--read-only'));assert.equal(args[args.indexOf('--network')+1],'none');assert.equal(args[args.indexOf('--user')+1],'65532:65532');assert.equal(args[args.indexOf('--pids-limit')+1],'256');assert.ok(args.includes('no-new-privileges'));}
 const smoke=collectionContainerArguments(env,'smoke','demo'),full=collectionContainerArguments(env,'render','demo');assert.ok(!smoke.includes('--terminal-capture'));assert.ok(full.includes('--terminal-capture'));assert.ok(full.includes('--rendition-set'));assert.ok(full.includes('/tmp:rw,noexec,nosuid,size=1g'));assert.ok(collectionContainerArguments(env,'validate','demo').includes('--validate-only'));assert.ok(collectionContainerArguments(env,'capture','demo').includes('/runtime/packages/core/providers/commands/auditable-demo-capture.py'));
 assert.throws(()=>collectionContainerArguments({...env,RENDERER_IMAGE:'mutable:latest'},'capture','demo'),/immutable/);assert.throws(()=>collectionContainerArguments(env,'capture','../escape'),/canonical/);
});
test('demo scenario and digest readers reject traversal and malformed coordinate data',t=>{
 const root=workspace(t);writeScenario(root);assert.equal(demoScenario({GITHUB_WORKSPACE:root,SCENARIO_PATH:'.buildchain/auditable-demo.json'}).scenario.demos.length,2);assert.throws(()=>demoScenario({GITHUB_WORKSPACE:root,SCENARIO_PATH:'../../escape.json'}),/checked-out source/);assert.equal(normalizedDemoDigest('a'.repeat(64)),`sha256:${'a'.repeat(64)}`);assert.throws(()=>normalizedDemoDigest('a\nforged=x'),/invalid/);
});
test('demo artifact download binding rejects duplicate and expired same-run artifacts',async()=>{
 const artifact={name:'binary',digest:`sha256:${'a'.repeat(64)}`,expired:false};const context={repo:{owner:'acme',repo:'demo'},runId:1};const github={rest:{actions:{listWorkflowRunArtifacts(){}}},paginate:async()=>[artifact,artifact]};const env={EXPECTED_NAME:'binary',EXPECTED_DIGEST:artifact.digest,COORDINATE_PATH:'binary-coordinate.json'};
 await assert.rejects(demoArtifactCoordinate({github,context},env),/absent or drifted/);github.paginate=async()=>[{...artifact,expired:true}];await assert.rejects(demoArtifactCoordinate({github,context},env),/absent or drifted/);
});
test('demo branch resolution never converts a provider failure into a new branch',t=>{
 const calls=[];assert.throws(()=>establishDemoBranch({GITHUB_WORKSPACE:workspace(t),SOURCE_SHA:sha},(_,args)=>{calls.push(args);if(args[0]==='ls-remote'){const error=new Error('denied');error.status=128;throw error;}return '';}),error=>error.status===128);assert.ok(!calls.some(args=>args[0]==='switch'));assert.throws(()=>demoBranchName('short'),/exact/);
});
test('demo materialization owns only source files and stages the optional declared technical specification',t=>{
 const root=workspace(t),value=writeScenario(root,true),env={GITHUB_WORKSPACE:root,SCENARIO_PATH:'.buildchain/auditable-demo.json',SOURCE_SHA:sha,GITHUB_REPOSITORY:'acme/demo',BASE_REF:'dev',BUILDCHAIN_WORKFLOW_SHA:sha,RENDERER_IMAGE:renderer};const targets=[];materializeDemoCollection(env,args=>targets.push(args));assert.equal(targets.length,2);assert.ok(targets.every(args=>args.repositoryRoot===path.join(root,'source')&&args.captureRoot.startsWith(path.join(root,'.demo-input/captures'))));
 const calls=[];const url=publishDemoPullRequest(env,(program,args,options)=>{calls.push({program,args,options});if(program==='gh')return '[{"url":"https://github.com/acme/demo/pull/1"}]';if(args[0]==='branch')return demoBranchName(sha);return '';});assert.equal(url,'https://github.com/acme/demo/pull/1');const staged=calls.find(call=>call.args[0]==='add');assert.deepEqual(staged.args,['add','--',value.publication.readmePath,value.publication.evidencePath,value.presentation.materialization.technicalSpecPath]);assert.equal(staged.options.cwd,path.join(root,'source'));assert.ok(!calls.some(call=>call.args.includes('config')||call.args.includes('push')));
});
test('advisory full-media failure preserves Gate qualification and suppresses publication',()=>{
 const workflow=YAML.parse(fs.readFileSync('.github/workflows/public-build-demo.yml','utf8'));const action=YAML.parse(fs.readFileSync('actions/build/demo-qualify/action.yml','utf8'));const gate=action.runs.steps.findIndex(s=>s.name==='Run required Gate for every declared demo'),render=action.runs.steps.findIndex(s=>s.id==='render');assert.ok(render>gate);assert.equal(action.runs.steps[render]['continue-on-error'],'${{ fromJSON(inputs.request-json).render-failure-advisory }}');assert.equal(action.outputs['render-result'].value,'${{ steps.render.outcome }}');assert.match(workflow.jobs.publish.if,/needs.qualify.outputs.render-result == 'success'/);assert.ok(Object.values(workflow.jobs).every(job=>job.steps.length===2));
 const publisher=YAML.parse(fs.readFileSync('actions/build/demo-publish/action.yml','utf8'));const source=publisher.runs.steps.find(s=>s.name==='Check out exact source with bounded update capability');assert.equal(source.with.path,'source');assert.equal(source.with['persist-credentials'],true);assert.equal(publisher.runs.steps[0].name,'Require explicit publication capability');
});
