import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { auditRuntimeEntry } from "../scripts/check-runtime-entry.mjs";
function fixture(t, steps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-entry-architecture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(file, value) { fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),YAML.stringify(value)); }
  write("actions/runtime/environment/prepare/action.yml", { runs: { using: "composite", steps: [{ uses: "actions/checkout@v7", with: { path: ".buildchain/runtime" } }] } });
  write(".github/workflows/build.yml", { jobs: { build: { steps } } });
  return root;
}
const prepare = { uses: "$/actions/runtime/environment/prepare" };
const business = { uses: "./.buildchain/runtime/actions/build/lifecycle/build" };
test("runtime preparation has one owner and precedes selected business actions", t => {
  assert.deepEqual(auditRuntimeEntry(fixture(t,[prepare,business])).issues,[]);
});
for(const [name,steps,reason] of [
  ["unprepared business",[business],"before preparation"],
  ["second preparation",[prepare,prepare,business],"more than once"],
  ["source erases runtime",[prepare,{uses:"actions/checkout@v7"},business],"erases"],
  ["entry supplies business code",[prepare,{uses:"$/actions/build/lifecycle/build"}],"selected runtime"],
  ["consumer supplies business code",[prepare,{uses:"./actions/build/lifecycle/build"}],"noncanonical"],
  ["independent runtime checkout",[{uses:"actions/checkout@v7",with:{path:".buildchain/runtime"}},business],"acquisition belongs"],
])test(`architecture rejects ${name}`,t=>{
  assert.ok(auditRuntimeEntry(fixture(t,steps)).issues.some(issue=>issue.includes(reason)));
});
