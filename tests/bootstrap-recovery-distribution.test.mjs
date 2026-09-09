import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const sha = "a".repeat(40);
function isolatedRecovery(t) {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-consumer-recovery-"));
  t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
  const installed = path.join(consumer, ".buildchain/bootstrap-recovery");
  fs.cpSync(path.join(root, "templates/bootstrap-recovery"), installed, { recursive: true });
  fs.mkdirSync(path.join(consumer, ".github/workflows"), { recursive: true });
  fs.copyFileSync(path.join(root, "templates/universal-buildchain-bootstrap-recovery.yml"), path.join(consumer, ".github/workflows/buildchain-bootstrap-recovery.yml"));
  return { consumer, installed };
}
test("consumer recovery package is complete and executes without repository or npm dependencies", (t) => {
  const { consumer, installed } = isolatedRecovery(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "manifest.json")));
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(installed, file.path));
    assert.equal(`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`, file.root, file.path);
  }
  const request = { schema: "kungfu-buildchain-v4-universal-workflow-request/v1", mode: "train", candidate: { repository: "kungfu-systems/buildchain", discoveryRef: "train/v4/v4.1/recovery", expectedSha: sha, reviewPullRequest: 123 } };
  const entry = path.join(installed, "packages/core/workflow/nodes/bootstrap-recovery.mjs");
  const run = spawnSync(process.execPath, [entry, "request"], { cwd: consumer, encoding: "utf8", env: { PATH: process.env.PATH, REQUEST_JSON: JSON.stringify(request), GITHUB_OUTPUT: path.join(consumer, "output") } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(fs.readFileSync(path.join(consumer, "output"), "utf8"), new RegExp(`sha=${sha}`));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(consumer, ".buildchain-request.json"))), request);
  assert.equal(fs.existsSync(path.join(consumer, "node_modules")), false);
  request.candidate.repository = "attacker/buildchain";
  const rejected = spawnSync(process.execPath, [entry, "request"], { cwd: consumer, encoding: "utf8", env: { PATH: process.env.PATH, REQUEST_JSON: JSON.stringify(request) } });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Buildchain capability Train/);
});
test("every consumer recovery node and nested action resolves inside the prepositioned package", (t) => {
  const { consumer } = isolatedRecovery(t);
  const workflow = YAML.parse(fs.readFileSync(path.join(consumer, ".github/workflows/buildchain-bootstrap-recovery.yml"), "utf8"));
  const resolve = (value) => path.join(consumer, value.replace("./.buildchain/workflow-shell/", ""), "action.yml");
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job.steps.length <= 3);
    for (const step of job.steps) {
      assert.equal(Object.hasOwn(step, "run"), false);
      if (!step.uses.startsWith("./")) continue;
      const action = YAML.parse(fs.readFileSync(resolve(step.uses), "utf8"));
      for (const nested of action.runs.steps) {
        if (nested.uses?.startsWith("./")) assert.ok(fs.existsSync(resolve(nested.uses)), nested.uses);
        if (nested.run?.includes("$GITHUB_ACTION_PATH/")) {
          const module = nested.run.match(/\$GITHUB_ACTION_PATH\/([^" ]+)/)[1];
          assert.ok(fs.existsSync(path.resolve(path.dirname(resolve(step.uses)), module)), module);
        }
      }
    }
  }
});
test("prepositioned review and receipt modules retain their own authority", async (t) => {
  const { installed } = isolatedRecovery(t);
  const review = await import(pathToFileURL(path.join(installed, "packages/core/workflow/nodes/bootstrap-review.mjs")));
  assert.equal(review.bootstrapVersionLine().development, "dev/v4/v4.1");
  const contract = await import(pathToFileURL(path.join(installed, "packages/core/workflow/nodes/recovery-contract.mjs")));
  assert.throws(() => contract.recoveryTerminalReceipt({ runtime: { sha } }, { runtime: { sha: "b".repeat(40) } }), /consumer-owned admission lineage/);
});
