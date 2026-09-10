import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../packages/core/release/commands/next-development-review.mjs", import.meta.url));
const repository = "kungfu-systems/buildchain", headSha = "a".repeat(40), baseSha = "b".repeat(40);
const branch = `chore/v4-product-pr/release-v4-v4.0/cccccccccccc-${baseSha.slice(0, 12)}-${headSha.slice(0, 12)}`;

function enqueue(scenario) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-finalization-merge-"));
  const plan = { schema: "buildchain.next-development-review/v1", repository, runId: 123, number: 42, headSha, baseSha, branch, reviewId: 91, kind: "stable-finalization" };
  const pull = { number: 42, node_id: "PR_exact", state: "open", draft: false, user: { login: "dongkeren" },
    head: { sha: headSha, ref: branch, repo: { full_name: repository } },
    base: { sha: baseSha, ref: "release/v4/v4.0", repo: { full_name: repository } } };
  const run = { id: 123, repository: { full_name: repository }, head_sha: headSha, head_branch: branch,
    path: ".github/workflows/self-build-verify.yml", name: "Verify", event: "pull_request", status: "completed", conclusion: "success" };
  fs.mkdirSync(path.join(cwd, ".buildchain"));
  fs.writeFileSync(path.join(cwd, ".buildchain/next-development-review.json"), JSON.stringify(plan));
  // Exercise the real CLI mode in a separate process. Only GitHub transport is
  // replaced; environment parsing, fresh observation, approval and exit codes run.
  const transport = `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const plan = ${JSON.stringify(plan)}, pull = ${JSON.stringify(pull)}, run = ${JSON.stringify(run)};
    const scenario = ${JSON.stringify(scenario)};
    const transportCall = (program, args) => {
      if (program !== 'gh') throw new Error('unexpected executable');
      if (args[0] === 'pr' && args[1] === 'merge') {
        fs.writeFileSync('merge-call.json', JSON.stringify(args));
        if (scenario === 'head-race') throw new Error('head commit does not match');
        if (scenario === 'protected-rejection') throw new Error('protected branch requirements not satisfied');
        return '';
      }
      const endpoint = args.find(value => value.startsWith("repos/") || value === "graphql");
      if (endpoint === 'graphql') throw new Error('Pull request Pull request is in unstable status');
      if (endpoint.endsWith('/jobs?filter=latest')) return JSON.stringify([{jobs:[{name:'check',status:'completed',conclusion:'success'}]}]);
      if (endpoint.endsWith('/reviews')) return JSON.stringify([scenario === 'missing-review' ? [] : [{id:91,user:{login:'kungfu-origin'},commit_id:plan.headSha,state:'APPROVED'}]]);
      if (endpoint.endsWith('/pulls')) return JSON.stringify([[pull]]);
      if (endpoint.endsWith('/pulls/42')) return JSON.stringify(pull);
      if (endpoint.includes('/git/ref/heads/')) return JSON.stringify({object:{sha:plan.baseSha}});
      if (endpoint.endsWith('/actions/runs/123')) return JSON.stringify(run);
      throw new Error('unexpected endpoint ' + endpoint);
    };
    cp.execFileSync = transportCall;
    cp.spawnSync = (program, args) => {
      try { return { status: 0, stdout: transportCall(program, args), stderr: "" }; }
      catch (error) { return { status: 1, stdout: "", stderr: error.message }; }
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(script)}, 'enqueue'];
    await import(pathToFileURL(process.argv[1]));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", transport], {
      cwd, encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: repository, VERIFY_RUN_ID: "123", GH_TOKEN: "test-transport-only" },
    });
    const file = path.join(cwd, "merge-call.json");
    return { ...result, merge: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : undefined };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test("ready finalization uses the protected CLI merge path with exact reviewed HEAD", () => {
  const result = enqueue("unstable");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.merge, ["pr", "merge", "42", "--repo", repository, "--merge", "--auto", "--match-head-commit", headSha]);
});

test("missing independent review rejects before any merge request", () => {
  const result = enqueue("missing-review");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /independent approval no longer qualifies/);
  assert.equal(result.merge, undefined);
});

test("changed HEAD and protected merge rejection remain failures without fallback", () => {
  for (const scenario of ["head-race", "protected-rejection"]) {
    const result = enqueue(scenario);
    assert.equal(result.status, 1);
    assert.ok(result.merge, result.stderr);
    assert.match(result.stderr, /head commit does not match|protected branch requirements not satisfied/);
  }
});
