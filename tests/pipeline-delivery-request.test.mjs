import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  preparePipelineDelivery,
  qualifyPipelineSourceRun,
} from "../packages/core/workflow/pipeline/delivery-request.js";
import { identities } from "./helpers/business-attempt.mjs";
import { bindConsumerSource } from "../packages/core/consumer/contract/identity.js";
import {
  sourceGeneration,
  businessAttempt,
} from "../packages/core/workflow/attempt/identity.js";
import {
  consumerWorkflows,
  PIPELINE_ENTRY,
} from "../packages/core/consumer/contract/entries.js";

test("internal delivery request derives real Git predicates and executes the owned native command", async (t) => {
  const f = identities(),
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-pipeline-predicates-"),
    );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, ".buildchain/candidate");
  fs.mkdirSync(cwd, { recursive: true });
  fs.symlinkSync(
    fileURLToPath(new URL("..", import.meta.url)),
    path.join(root, ".buildchain/runtime"),
    "dir",
  );
  fs.cpSync(
    new URL("../templates/minimal-consumer/npm/.buildchain", import.meta.url),
    path.join(cwd, ".buildchain"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, ".github/workflows"), { recursive: true });
  for (const [file, bytes] of Object.entries(consumerWorkflows()))
    fs.writeFileSync(path.join(cwd, file), bytes);
  fs.writeFileSync(
    path.join(cwd, "src/build.mjs"),
    "import fs from 'node:fs'; fs.writeFileSync('artifact.txt','original');\n",
  );
  fs.writeFileSync(
    path.join(cwd, "src/verify.mjs"),
    "import fs from 'node:fs'; if (!fs.existsSync('artifact.txt')) process.exit(2);\n",
  );
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const baseCommit = commit();
  fs.writeFileSync(
    path.join(cwd, "src/build.mjs"),
    "import fs from 'node:fs'; fs.writeFileSync('artifact.txt','updated');\n",
  );
  const sourceHead = commit(),
    configPath = ".buildchain/buildchain.toml";
  const { identity: source } = bindConsumerSource(
    {
      repository: f.intent.repository,
      commit: sourceHead,
      tree: git("rev-parse", "HEAD^{tree}"),
      configPath,
      configBlob: git("rev-parse", `HEAD:${configPath}`),
    },
    fs.readFileSync(path.join(cwd, configPath)),
  );
  const current = {
    intent: f.intent,
    generation: sourceGeneration(f.intent, source, baseCommit),
  };
  current.identity = businessAttempt({
    intent: f.intent,
    generation: current.generation,
    requestKey: "test",
  });
  const run = {
    id: 100,
    status: "completed",
    conclusion: "success",
    event: "pull_request",
    repository: { full_name: f.intent.repository },
    head_sha: sourceHead,
    path: ".github/workflows/buildchain.yml",
    pull_requests: [{ number: 23, base: { sha: baseCommit } }],
    referenced_workflows: [
      {
        path: `kungfu-systems/buildchain/${PIPELINE_ENTRY}@v4`,
        sha: "d".repeat(40),
      },
    ],
  };
  const request = await preparePipelineDelivery(
    { current, run, runtimeSha: "a".repeat(40) },
    async (coordinates, operation) => {
      assert.equal(coordinates.sourceHead, sourceHead);
      return operation(cwd);
    },
  );
  assert.equal(request["expected-head-sha"], sourceHead);
  assert.equal(request["delivery-warrant-mode"], "required");
  assert.deepEqual(JSON.parse(request["affected-paths-json"]), [
    "src/build.mjs",
  ]);
  for (const key of [
    "source-root",
    "source-identity-root",
    "source-patch-root",
    "closure-root",
    "dependency-root",
    "environment-root",
  ])
    assert.match(request[key], /^sha256:[0-9a-f]{64}$/u);
  execFileSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-c", request["native-command"]],
    { cwd },
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "artifact.txt"), "utf8"),
    "updated",
  );
  assert.throws(
    () => qualifyPipelineSourceRun({ ...run, status: "in_progress" }, current),
    /exact PR generation/,
  );
  assert.throws(
    () =>
      qualifyPipelineSourceRun(
        { ...run, path: ".github/workflows/unrelated.yml" },
        current,
      ),
    /exact PR generation/,
  );
  assert.throws(
    () =>
      qualifyPipelineSourceRun({ ...run, referenced_workflows: [] }, current),
    /exact published entry/,
  );
});
