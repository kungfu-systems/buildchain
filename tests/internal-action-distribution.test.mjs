import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

function installation(t, action, workflowBound = false) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-action-distribution-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const runtime = path.join(source, ".buildchain/workflow-shell");
  const entry = workflowBound
    ? path.join(runtime, `actions/${action}/dist/index.js`)
    : path.join(root, "entry.mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(
    new URL(`../actions/${action}/dist/index.js`, import.meta.url),
    entry,
  );
  let workflowSha;
  if (workflowBound) {
    for (const file of [
      "package.json",
      "bin/buildchain.mjs",
      "architecture/code-layout.json",
    ]) {
      fs.mkdirSync(path.dirname(path.join(runtime, file)), { recursive: true });
      fs.copyFileSync(
        new URL(`../${file}`, import.meta.url),
        path.join(runtime, file),
      );
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
        "exact workflow distribution",
      ],
    ])
      execFileSync("git", args, { cwd: runtime, stdio: "pipe" });
    workflowSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: runtime,
      encoding: "utf8",
    }).trim();
  }
  const output = path.join(root, "outputs"),
    summary = path.join(root, "summary"),
    event = path.join(root, "event.json");
  fs.writeFileSync(output, "");
  fs.writeFileSync(summary, "");
  fs.writeFileSync(event, "{}");
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: source,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_EVENT_PATH: event,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: "fixture/source",
    GITHUB_SHA: "a".repeat(40),
    RUNNER_TEMP: root,
  };
  const run = (inputs) =>
    spawnSync(process.execPath, [entry], {
      cwd: source,
      encoding: "utf8",
      env: {
        ...env,
        ...Object.fromEntries(
          Object.entries(inputs).map(([key, value]) => [
            `INPUT_${key.toUpperCase()}`,
            String(value),
          ]),
        ),
      },
    });
  return { root, source, output, summary, run, workflowSha };
}

test("distributed source admission runs without source modules or installed dependencies and rejects checkout failure", (t) => {
  const f = installation(t, "build/source/admit");
  const result = f.run({ "source-checkout-outcome": "failure" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Source checkout did not succeed/);
  assert.equal(fs.readFileSync(f.output, "utf8"), "");
});

test("distributed runtime admission preserves defining workflow identity without querying the provider", (t) => {
  const f = installation(t, "runtime/selection/admit"),
    sha = "b".repeat(40);
  const result = f.run({
    purpose: "publication",
    repository: "fixture/runtime",
    "workflow-sha": sha,
    "workflow-ref": "fixture/runtime/.github/workflows/public.yml@v4-alpha",
    token: "non-secret-test-token",
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = fs.readFileSync(f.output, "utf8");
  assert.ok(output.includes(sha));
  assert.ok(!output.includes("a".repeat(40)));
  assert.match(output, /workflow-definition/);
});

test("distributed release-line dry run reads a clean source and cannot mutate it", (t) => {
  const f = installation(t, "release/line/bootstrap", true);
  fs.writeFileSync(
    path.join(f.source, "package.json"),
    JSON.stringify({ name: "fixture", version: "4.0.10" }),
  );
  for (const args of [
    ["init", "-q"],
    ["add", "package.json"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
  ])
    execFileSync("git", args, { cwd: f.source, stdio: "pipe" });
  fs.appendFileSync(
    path.join(f.source, ".git/info/exclude"),
    "\n.buildchain/workflow-shell/\n",
  );
  const result = f.run({
    "workflow-sha": f.workflowSha,
    "request-json": JSON.stringify({
      major: "4",
      minor: "1",
      "source-ref": "release/v4/v4.0",
      apply: false,
      "set-default-branch": true,
      "create-alpha-pr": true,
    }),
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: f.source,
      encoding: "utf8",
    }),
    "",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.source, "package.json"))).version,
    "4.0.10",
  );
  assert.match(fs.readFileSync(f.summary, "utf8"), /dry run/);
  assert.equal(
    fs.existsSync(path.join(f.root, "buildchain-line-123-1-write.json")),
    false,
  );
});

test("shared action build closes WASM resources and the isolated bundle fails closed without them", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-wasm-bundle-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const authority = fileURLToPath(
    new URL("../packages/core/runtime/domain-wasm.js", import.meta.url),
  );
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(root, "index.js"),
    `import { domainWasmInfo } from ${JSON.stringify(authority)}; console.log(JSON.stringify(domainWasmInfo()));\n`,
  );
  const build = spawnSync(
    process.execPath,
    [
      path.join(repository, "node_modules/tsup/dist/cli-default.js"),
      "index.js",
      "--format",
      "esm",
      "--config",
      path.join(repository, "scripts/tsup-action.config.mjs"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const artifact = path.join(root, "dist/buildchain-domain.wasm");
  const bytes = fs.readFileSync(artifact);
  assert.deepEqual(
    bytes,
    fs.readFileSync(
      path.join(repository, "packages/core/runtime/buildchain-domain.wasm"),
    ),
  );
  fs.unlinkSync(path.join(root, "index.js"));
  const run = () =>
    spawnSync(process.execPath, [path.join(root, "dist/index.js")], {
      cwd: root,
      encoding: "utf8",
    });
  const healthy = run();
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).abiVersion, 1);
  fs.unlinkSync(artifact);
  assert.notEqual(run().status, 0);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(artifact, bytes);
  assert.notEqual(run().status, 0);
});
