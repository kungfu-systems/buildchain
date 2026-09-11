import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bindPromotionInvocation } from "../packages/core/release/promotion-request.js";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));

function distribution(t, action, workflowBound = false, resources = []) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-promotion-bundle-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "source");
  const runtime = workflowBound
    ? path.join(workspace, ".buildchain/workflow-shell")
    : workspace;
  const directory = `actions/${action}/dist`;
  fs.mkdirSync(path.join(runtime, directory), { recursive: true });
  fs.cpSync(path.join(repository, directory), path.join(runtime, directory), {
    recursive: true,
  });
  for (const file of [
    "package.json",
    "bin/buildchain.mjs",
    "architecture/code-layout.json",
    "contracts/promotion-request-v1.schema.json",
    "contracts/promotion-invocation-v1.schema.json",
    ...resources,
  ]) {
    fs.mkdirSync(path.dirname(path.join(runtime, file)), { recursive: true });
    fs.copyFileSync(path.join(repository, file), path.join(runtime, file));
  }
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "distribution",
    ],
  ])
    execFileSync("git", args, { cwd: runtime, stdio: "pipe" });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: runtime,
    encoding: "utf8",
  }).trim();
  const output = path.join(root, "outputs"),
    event = path.join(root, "event.json");
  fs.writeFileSync(output, "");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("INPUT_")),
    ),
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: output,
    GITHUB_EVENT_PATH: event,
    GITHUB_REPOSITORY: "fixture/source",
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_REF: "refs/heads/dev/v4/v4.1",
    INPUT_TOKEN: "non-secret-test-token",
  };
  const run = async (payload, inputs = {}) => {
    fs.writeFileSync(event, JSON.stringify(payload));
    fs.writeFileSync(output, "");
    try {
      const result = await execute(
        process.execPath,
        [path.join(runtime, directory, "index.js")],
        {
          cwd: workspace,
          env: { ...env, ...inputs },
          timeout: 15000,
        },
      );
      return { ...result, status: 0, output: fs.readFileSync(output, "utf8") };
    } catch (error) {
      return {
        status: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
        output: fs.readFileSync(output, "utf8"),
      };
    }
  };
  return { sha, env, run };
}

async function provider(t, sha) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      request.url === `/repos/fixture/source/git/commits/${sha}`
    )
      response.end(JSON.stringify({ sha, tree: { sha: "b".repeat(40) } }));
    else if (
      request.method === "GET" &&
      decodeURIComponent(request.url).startsWith(
        "/repos/fixture/source/git/matching-refs/heads/buildchain/v4-product-state/",
      )
    )
      response.end("[]");
    else {
      response.statusCode = 500;
      response.end(
        JSON.stringify({ message: "unexpected provider operation" }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test("distributed publication classifier uses the verified workflow-run source, independent of the default branch SHA", async (t) => {
  const f = distribution(t, "release/candidate/classify-publication");
  const api = await provider(t, f.sha);
  f.env.GITHUB_API_URL = api.url;
  const result = await f.run({
    workflow_run: { head_sha: f.sha, head_branch: "alpha/v4/v4.1" },
  });
  assert.equal(
    result.status,
    0,
    result.stdout + result.stderr + JSON.stringify(api.requests),
  );
  assert.match(result.output, /promote/);
  assert.equal(api.requests.length, 2);
  assert.ok(api.requests.every(({ method }) => method === "GET"));
  assert.ok(api.requests.some(({ url }) => url.endsWith(f.sha)));
});

test("distributed publication classifier rejects missing or malformed workflow-run source before provider reads", async (t) => {
  const f = distribution(t, "release/candidate/classify-publication");
  const api = await provider(t, f.sha);
  f.env.GITHUB_API_URL = api.url;
  for (const [payload, message] of [
    [{}, /workflow run with an exact source SHA/],
    [
      { workflow_run: { head_sha: "v4-alpha" } },
      /workflow run with an exact source SHA/,
    ],
  ]) {
    const result = await f.run(payload);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, message);
    assert.equal(result.output, "");
  }
  assert.deepEqual(api.requests, []);
});

test("distributed invocation verification loads its own promotion schemas and retains closed typed validation", async (t) => {
  const f = distribution(t, "release/promotion/inspect-invocation", true);
  const foreignContracts = path.join(f.env.GITHUB_WORKSPACE, "contracts");
  fs.mkdirSync(foreignContracts);
  for (const kind of ["request", "invocation"])
    fs.writeFileSync(
      path.join(foreignContracts, `promotion-${kind}-v1.schema.json`),
      "invalid consumer schema",
    );
  const root = `sha256:${"b".repeat(64)}`;
  const selection = {
    "runtime-sha": f.sha,
    "shell-sha": f.sha,
    "router-sha": f.sha,
    "shell-call-ref": f.sha,
    "runtime-ref": f.sha,
    "router-ref": "dev/v4/v4.1",
    "contract-lock-path": ".buildchain/alpha-contract-lock.json",
    "contract-lock-digest": root,
    channel: "alpha",
    "publication-channel": "alpha",
    "target-ref": "alpha/v4/v4.1",
    "override-used": "false",
  };
  const invocation = bindPromotionInvocation(
    { schema: "buildchain.promotion-request/v1" },
    selection,
  );
  const run = (value) =>
    f.run(
      {},
      {
        "INPUT_WORKFLOW-SHA": f.sha,
        "INPUT_REQUEST-JSON": JSON.stringify(value),
      },
    );
  const valid = await run(invocation);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  for (const change of [
    { "dry-run": "false" },
    { unknown: true },
  ]) {
    const result = await run({ ...invocation, ...change });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /must be boolean|Unsupported promotion invocation field|defining workflow/,
    );
  }
});

test("distributed self-dogfood generates conformance and release requests from its installed workflow manifest", async (t) => {
  const f = distribution(t, "workflow/dogfood/generate", false, [
    "architecture/universal-workflow-capability-policy.json",
    "architecture/universal-workflow-bootstrap.json",
  ]);
  const result = await f.run(
    {},
    {
      "INPUT_COORDINATES-JSON": JSON.stringify({
        "candidate-sha": f.sha,
        "consumer-sha": "d".repeat(40),
        "pull-request": "42",
      }),
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const channel of ["conformance", "alpha", "stable"])
    assert.ok(result.output.includes(`${channel}-request<<`));
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(repository, "architecture/universal-workflow-bootstrap.json"),
    ),
  );
  assert.ok(
    result.output.includes(
      `"expectedGovernedWorkflowCount":${manifest.bootstrapGovernedWorkflows.length}`,
    ),
  );
});
