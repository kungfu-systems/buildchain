import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { qualifyStageCapsuleConsumer } from "../packages/core/build/stage-capsule/canary.js";

const runtimeRoot = path.resolve(import.meta.dirname, "..");
test("one consumer qualification retains lifecycle environment and proves clean process recovery", async (t) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "capsule-consumer-action-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.cpSync(path.join(runtimeRoot, "fixtures/libnode-shaped"), workspace, {
    recursive: true,
  });
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(workspace, "empty.gitconfig"),
    GITHUB_OUTPUT: path.join(workspace, "outputs"),
    GITHUB_ENV: path.join(workspace, "environment"),
  };
  fs.writeFileSync(environment.GIT_CONFIG_GLOBAL, "");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    }).trim();
  git("init", "--quiet");
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
  const sourceSha = git("rev-parse", "HEAD");
  fs.appendFileSync(
    path.join(workspace, "scripts/install.mjs"),
    '\nfs.appendFileSync(process.env.GITHUB_ENV, "CAPSULE_INSTALL_STATE=retained\\n"); fs.appendFileSync(process.env.GITHUB_OUTPUT, "forged-authority=must-stay-private\\n");\n',
  );
  fs.appendFileSync(
    path.join(workspace, "scripts/build.mjs"),
    '\nif (process.env.CAPSULE_INSTALL_STATE !== "retained" || process.env.CANARY_CONSUMER !== "sample-consumer" || process.env.CANARY_ARTIFACT_PATH !== "dist") throw new Error("Lifecycle environment was lost");\n',
  );
  const report = await qualifyStageCapsuleConsumer({
    workspace,
    runtimeRoot,
    runtimeSha: "a".repeat(40),
    sourceSha,
    platform: "linux-x64",
    environment,
    request: {
      consumer: "sample-consumer",
      "install-artifact-path": "dist",
      "build-artifact-path": "dist",
      "verify-artifact-path": "dist",
    },
  });
  assert.equal(report.consumer, "sample-consumer");
  assert.equal(report.productionWrites, false);
  assert.equal(report.providerEffects, false);
  assert.deepEqual(
    report.processRuns.map((run) => run.id),
    ["seed", "resume"],
  );
  assert.equal(report.metrics.plannerAccurate, true);
  assert.equal(
    fs.existsSync(environment.GITHUB_OUTPUT),
    false,
    "Consumer output must not become action authority output",
  );
  for (const stage of ["install", "build", "verify"]) {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(
          workspace,
          `.buildchain/artifacts/stage-capsule-canary/${stage}-manifest.json`,
        ),
      ),
    );
    assert.equal(manifest.lifecycle.stage, stage);
    assert.equal(manifest.git.sha, sourceSha);
  }
});
