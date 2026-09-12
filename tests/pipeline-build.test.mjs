import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { bindConsumerSource } from "../packages/core/consumer/contract/identity.js";
import { buildPipelineSource } from "../packages/core/workflow/pipeline/build.js";

function checkout(t, verify) {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-pipeline-build-"),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.cpSync(
    new URL("../templates/minimal-consumer/npm/.buildchain", import.meta.url),
    path.join(cwd, ".buildchain"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(
    path.join(cwd, "src/build.mjs"),
    "import fs from 'node:fs'; fs.writeFileSync('built.txt', 'built');\n",
  );
  fs.writeFileSync(path.join(cwd, "src/verify.mjs"), verify);
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Buildchain Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const configPath = ".buildchain/buildchain.toml";
  const { identity: source } = bindConsumerSource(
    {
      repository: "example/consumer",
      commit: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      configPath,
      configBlob: git("rev-parse", `HEAD:${configPath}`),
    },
    fs.readFileSync(path.join(cwd, configPath)),
  );
  return { cwd, source, platform: "linux-x64" };
}

test("real product subprocesses receive no provider credential or authority output file", async (t) => {
  const request = checkout(
    t,
    `import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(fs.readFileSync('built.txt', 'utf8'), 'built');
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, undefined);
fs.writeFileSync(process.env.GITHUB_OUTPUT, 'qualified=true');
`,
  );
  const output = path.join(request.cwd, "authority-output");
  const result = await buildPipelineSource({
    ...request,
    environment: {
      ...process.env,
      GITHUB_TOKEN: "test-secret",
      GH_TOKEN: "test-secret",
      ACTIONS_RUNTIME_TOKEN: "test-secret",
      GITHUB_OUTPUT: output,
    },
  });
  assert.equal(result.products[0].outcome, "success");
  assert.equal(fs.existsSync(output), false);
});

test("product verification exit failure and tracked drift never produce success", async (t) => {
  const request = checkout(t, "process.exit(7);\n");
  await assert.rejects(
    buildPipelineSource(request),
    (error) => error.status === 7,
  );
  fs.writeFileSync(
    path.join(request.cwd, "src/verify.mjs"),
    "process.exit(0);\n",
  );
  await assert.rejects(buildPipelineSource(request), /tracked modifications/);
});
