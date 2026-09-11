import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { qualifyObservedEvidence, publishQualifiedEvidence } from "../packages/core/observability/evidence/transactions.js";
import { evidencePublisherAdmissionAction } from "../packages/core/observability/publisher-admission.js";
const root = process.cwd();
const request = {
  "manifest-path": "evidence/manifest.json",
  "artifact-path": "evidence $(touch injected)",
  "production-bucket": "example-bucket",
  "cloudfront-distribution": "",
};
test("Evidence qualification preserves shell failure semantics and publishes only after receipt success", async t => {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),"observed-transaction-"));t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  const calls=[];const input={request:{...request,"build-command":"build","verify-command":"verify"},workspace,environment:{},token:"build-token"};
  const result=await qualifyObservedEvidence(input,{execute:(program,args,options)=>{assert.equal(program,"bash");assert.ok(args.includes("pipefail"));assert.ok(!args.includes("-u"));calls.push(args.at(-1));if(args.at(-1)==="build")fs.writeFileSync(options.env.GITHUB_ENV,"FROM_BUILD=present\n");else assert.equal(options.env.FROM_BUILD,"present");},publish:options=>{calls.push("admit");assert.equal(options.dryRun,true);assert.equal(options.artifactRoot,path.resolve(workspace,request["artifact-path"]));return {status:"planned"};}});
  assert.deepEqual(calls,["build","verify","admit"]);assert.equal(result.status,"planned");
  assert.throws(()=>publishQualifiedEvidence(input,{publish:()=>{throw Object.assign(new Error("provider failed"),{status:17});}}),error=>error.status===17);
  assert.equal(fs.existsSync(path.join(workspace,".buildchain/observed-evidence/receipt.json")),false);
  const published=publishQualifiedEvidence(input,{publish:options=>{assert.equal(options.dryRun,false);return {status:"published"};}});
  assert.equal(JSON.parse(fs.readFileSync(published.receiptPath,"utf8")).status,"published");
});
test("observed evidence admits the default branch before publication and rejects pull requests", (t) => {
  const workflow = YAML.parse(
    fs.readFileSync(
      path.join(root, ".github/workflows/public-ops-observed-evidence.yml"),
      "utf8",
    ),
  );
  const steps = workflow.jobs.publish.steps;
  assert.equal(
    steps[2].uses,
    "./.buildchain/runtime/actions/observability/evidence/admit-publisher",
  );
  assert.equal(steps[0].with.ref, "${{ github.sha }}");
  assert.equal(
    steps[3].with["source-checkout-outcome"],
    "${{ steps.source-checkout.outcome }}",
  );
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"observed-admit-"));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const eventPath=path.join(cwd,"event.json");fs.writeFileSync(eventPath,JSON.stringify({repository:{default_branch:"main"}}));
  for(const [event,ref,ok] of [["schedule","refs/heads/main",true],["workflow_dispatch","refs/heads/main",true],["pull_request","refs/heads/main",false],["workflow_dispatch","refs/heads/feature/test",false]]){
    const run=()=>evidencePublisherAdmissionAction({},{GITHUB_EVENT_NAME:event,GITHUB_REF:ref,GITHUB_EVENT_PATH:eventPath});
    if(ok)assert.doesNotThrow(run);else assert.throws(run);
  }
  const publication = YAML.parse(
    fs.readFileSync(
      path.join(root, "actions/observability/evidence/publish/action.yml"),
      "utf8",
    ),
  );
  const before = publication.runs.steps.findIndex(
    (s) => s.uses?.endsWith("/actions/observability/evidence/qualify"),
  );
  const credentials = publication.runs.steps.findIndex((s) =>
    s.uses?.startsWith("aws-actions/configure-aws-credentials@"),
  );
  assert.ok(before >= 0 && before < credentials);
});
