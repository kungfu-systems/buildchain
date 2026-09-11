import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareReleaseConsumerDependencies } from "../packages/core/workflow/engine/release-environment.js";
import { inspectWorkflowJob } from "../scripts/workflow-action-graph.mjs";

test("the public capability job prepares runtime before executing consumer logic", () => {
  const graph = inspectWorkflowJob(".github/workflows/public-ops-bootstrap.yml", "execute");
  const prepare = graph.steps.findIndex(step => step.uses === "$/actions/runtime/environment/prepare");
  const engine = graph.steps.findIndex(step => step.uses?.endsWith("/workflow/engine/execute"));
  assert.ok(prepare >= 0 && engine > prepare);
});

for(const [manager,args] of [
  ["pnpm@11.7.0",["install","--frozen-lockfile","--ignore-scripts"]],
  ["npm@11.13.0",["ci","--ignore-scripts"]],
  ["yarn@1.22.22",["install","--frozen-lockfile","--ignore-scripts"]],
  ["yarn@4.9.2",["install","--immutable","--mode=skip-builds"]],
])test(`release consumer installs ${manager} without mutating runtime dependencies`,t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"consumer-dependencies-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({packageManager:manager}));
  const runtime=path.join(root,".buildchain/runtime/node_modules");fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(path.join(runtime,"sentinel"),"runtime");
  const calls=[];prepareReleaseConsumerDependencies(root,(...call)=>calls.push(call));
  assert.deepEqual(calls,[["corepack",[manager,...args],{cwd:root,stdio:["ignore",2,2]}]]);
  assert.equal(fs.existsSync(path.join(root,"node_modules")),false);
  assert.equal(fs.readFileSync(path.join(runtime,"sentinel"),"utf8"),"runtime");
});
