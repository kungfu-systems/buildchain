import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { admitGithubAccess, selectGithubToken } from "../packages/core/providers/github-token.js";
import { finalizeGovernanceEvidence } from "../packages/core/governance/audit/transactions.js";

test("Governance audit preserves evidence before qualification and uses bounded organization credential scope", () => {
  const action=YAML.parse(fs.readFileSync("actions/governance/repository/audit/action.yml","utf8"));
  assert.ok(action.runs.steps.every(step=>step.uses && !step.run && !step.with?.script));
  const upload=action.runs.steps.findIndex(step=>step.uses.startsWith("actions/upload-artifact@"));
  const finalize=action.runs.steps.findIndex(step=>step.uses.endsWith("/finalize-audit"));
  assert.ok(upload>=0 && finalize>upload);
  const credential=action.runs.steps.find(step=>step.id==='credential');
  assert.equal(credential.with.organization,'${{ github.repository_owner }}');
  assert.equal(credential.with['fallback-token'],'${{ inputs.governance-read-token }}');
});
test("GitHub access admission distinguishes exact repository and explicit organization scopes before token creation", () => {
  const configuration={clientConfigured:false,appIdConfigured:true,privateKeyConfigured:true,failurePolicy:'strict'};
  assert.deepEqual(admitGithubAccess({...configuration,repository:'example/site'}),{repository:'example/site',owner:'example',name:'site',requested:true});
  assert.deepEqual(admitGithubAccess({...configuration,organization:'example'}),{repository:'',owner:'example',name:'',requested:true});
  assert.throws(()=>admitGithubAccess({...configuration,organization:'example',repository:'example/site'}),/exactly one/);
  assert.throws(()=>admitGithubAccess({...configuration,repository:'example/site',privateKeyConfigured:false}),/provided together/);
  assert.throws(()=>selectGithubToken({clientConfigured:true,privateKeyConfigured:true,appOutcome:'failure',fallbackToken:'credential',failurePolicy:'strict'}),/unavailable/);
});
test("Only credential-limited fork governance may retain a non-qualifying audit without failing the job", async () => {
  const request={receipt:{inventory:{nonQualifyingCount:1},auditRoot:'sha256:'+"a".repeat(64)},event:{name:'pull_request',payload:{pull_request:{head:{repo:{fork:true}}}}},credential:{source:'workflow'}};
  const limited=await finalizeGovernanceEvidence(request,{});assert.equal(limited.qualified,false);assert.match(limited.warning,/credential-limited/);
  await assert.rejects(finalizeGovernanceEvidence({...request,credential:{source:'app'}},{}),/non-qualifying/);
  await assert.rejects(finalizeGovernanceEvidence({...request,event:{name:'merge_group',payload:{}}},{}),/non-qualifying/);
});
test("Scheduled governance reports one existing incident before enforcing failure", async () => {
  const calls=[];const github={paginate:async()=>[{title:'[governance] Managed zone is non-qualifying',body:'<!-- kungfu-github-governance-authority-drift -->',number:7}],rest:{issues:{listForRepo(){},update:async request=>calls.push(request),create:()=>assert.fail('must reuse existing incident')}}};
  await assert.rejects(finalizeGovernanceEvidence({receipt:{inventory:{nonQualifyingCount:2},auditRoot:'sha256:'+'a'.repeat(64)},event:{name:'schedule',payload:{}},credential:{source:'app'},context:{repo:{owner:'example',repo:'site'},runId:'12',serverUrl:'https://github.com'}},github),/non-qualifying/);
  assert.equal(calls.length,1);assert.equal(calls[0].issue_number,7);assert.match(calls[0].body,/Non-qualifying repositories: 2/);
});
