import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { planReleaseLineBootstrap } from "../packages/core/release/release-line-bootstrap.js";
import { lineProtection } from "../packages/core/release/line/protection.js";
import { configureLineGovernance } from "../packages/core/release/line/governance.js";
import { applyLineSource } from "../packages/core/release/line/source.js";
function fixture(t, optional = false) {
 const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "line-node-"));t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
 fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "4.0.10" }));
 execFileSync("git", ["init", "-q"], { cwd });execFileSync("git", ["add", "package.json"], { cwd });
 execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd });
 return planReleaseLineBootstrap({ cwd, major: 4, minor: 1, sourceRef: "release/v4/v4.0", setDefault: optional, createAlphaPr: optional });
}
function governanceFixture(plan, devSha) {
 const calls = [], bodies = new Map();let created = false;
 return { calls, bodies, providers: {
  api: { request: async (method, endpoint, body) => { calls.push(method);bodies.set(endpoint, body); }, json: async endpoint => {
   calls.push("GET");const body = bodies.get(endpoint);
   return endpoint.endsWith("/protection") ? { ...body, enforce_admins: { enabled: body.enforce_admins }, required_conversation_resolution: { enabled: body.required_conversation_resolution } } : body;
  } },
  queue: async () => { calls.push("queue");return { status: "verified" }; },
  pullRequests: { listOpen: async () => { calls.push("PR-read"); return created ? [{ number: 1, head: { ref: plan.refs.dev, sha: devSha }, base: { ref: plan.refs.alpha } }] : []; }, create: async () => { calls.push("PR-create"); created = true; } },
 } };
}
test("release line protection bodies and separate readback precede queue and optional repository changes", async t => {
 const plan = fixture(t, true), devSha = "b".repeat(40), f = governanceFixture(plan, devSha);
 const result = await configureLineGovernance({ plan, repository: "fixture/repo", apply: true, devSha }, f.providers);
 assert.deepEqual(f.calls, ["PUT", "GET", "PUT", "GET", "PUT", "GET", "queue", "PATCH", "GET", "PR-read", "PR-create", "PR-read"]);
 assert.equal(result.alphaPr, 1);
 for (const channel of ["dev", "alpha", "release"]) {
  const body = f.bodies.get(`repos/fixture/repo/branches/${encodeURIComponent(plan.refs[channel])}/protection`);
  assert.deepEqual(body, lineProtection(plan, channel)); assert.equal(body.required_status_checks.strict, channel === "release");
  assert.deepEqual(body.required_status_checks.checks.map(x => x.context), channel === "alpha" ? ["check", "verify"] : ["check"]);
  assert.equal(body.required_pull_request_reviews.require_last_push_approval, true);
 }
});
test("dry run, failed protection readback and failed queue cannot change default branch or open alpha PR", async t => {
 const plan = fixture(t, true), f = governanceFixture(plan, "b".repeat(40));
 await assert.rejects(configureLineGovernance({ plan, repository: "fixture/repo", apply: false }, f.providers), /apply=true/);assert.deepEqual(f.calls, []);
 await assert.rejects(configureLineGovernance({ plan, repository: "fixture/repo", apply: true }, { ...f.providers, api: { ...f.providers.api, json: async () => ({}) } }), /did not read back/);
 assert.deepEqual(f.calls, ["PUT"]);f.calls.length = 0;
 await assert.rejects(configureLineGovernance({ plan, repository: "fixture/repo", apply: true }, { ...f.providers, queue: async () => { throw Error("queue rejected"); } }), /queue rejected/);
 assert.equal(f.calls.includes("PATCH"), false);assert.equal(f.calls.includes("PR-create"), false);
});
test("version commit stages declared output files and verifies each exact ref while preserving baseline alpha and release", t => {
 const plan = fixture(t), devSha = "b".repeat(40), calls = [];let headReads = 0;
 const execute = (_command, args) => {
  calls.push(args);
  if (args[0] === "rev-parse") return headReads++ ? devSha : plan.source.sha;
  if (args[0] === "status") return "";
  if (args[0] === "ls-remote") { const ref = args.at(-1);return `${ref.endsWith(plan.refs.alpha) || ref.endsWith(plan.refs.release) ? plan.source.sha : devSha}\t${ref}\n`; }
  return "";
 };
 const result = applyLineSource({ plan, apply: true }, { execute, writeVersion: () => ({ ...plan, changedFiles: ["package.json", "dist/site/manifest.json"] }) });
 assert.equal(result.devSha, devSha);assert.deepEqual(calls.find(args => args[0] === "add"), ["add", "--", "package.json", "dist/site/manifest.json"]);
 assert.equal(calls.filter(args => args[0] === "ls-remote").length, 4);
 assert.deepEqual(calls.filter(args => args[0] === "push").map(args => args.at(-1)), [`${devSha}:refs/heads/${plan.refs.bootstrap}`, `${devSha}:refs/heads/${plan.refs.dev}`, `${plan.source.sha}:refs/heads/${plan.refs.alpha}`, `${plan.source.sha}:refs/heads/${plan.refs.release}`]);
 assert.ok(calls.some(args => args.includes("-s")));assert.equal(calls.some(args => args.includes("--force")), false);
});
test("source drift and dry run are rejected before version-state generation", t => {
 const plan = fixture(t), writeVersion = () => assert.fail("unexpected version write");
 assert.throws(() => applyLineSource({ plan, apply: false }, { execute: () => assert.fail("unexpected Git effect"), writeVersion }), /apply=true/);
 assert.throws(() => applyLineSource({ plan, apply: true }, { execute: () => "f".repeat(40), writeVersion }), /Source changed/);
});
