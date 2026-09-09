import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import {
  evidenceArguments,
  publishEvidence,
} from "../packages/core/observability/nodes/publish-evidence.mjs";
const root = process.cwd();
const request = {
  "manifest-path": "evidence/manifest.json",
  "artifact-path": "evidence $(touch injected)",
  "production-bucket": "example-bucket",
  "cloudfront-distribution": "",
};
const env = { BUILDCHAIN_EVIDENCE_REQUEST_JSON: JSON.stringify(request) };
test("observed evidence verification has no write flag and publication passes literal paths", () => {
  const verify = evidenceArguments(env, "verify");
  assert.equal(verify.includes("--execute"), false);
  assert.equal(
    verify[verify.indexOf("--artifact-root") + 1],
    request["artifact-path"],
  );
  const publish = evidenceArguments(env, "publish");
  assert.equal(publish[publish.indexOf("--execute") + 1], "true");
});
test("observed evidence publishes an output only after provider success and a real receipt", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "observed-node-"));
  process.chdir(cwd);
  t.after(() => {
    process.chdir(root);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const input = { ...env, GITHUB_OUTPUT: path.join(cwd, "output") };
  assert.throws(
    () =>
      publishEvidence(input, () => {
        throw Object.assign(new Error("provider failed"), { status: 17 });
      }),
    (e) => e.status === 17,
  );
  assert.equal(fs.existsSync(input.GITHUB_OUTPUT), false);
  assert.throws(() => publishEvidence(input, () => {}), /did not produce/);
  publishEvidence(input, () =>
    fs.writeFileSync(".buildchain/observed-evidence/receipt.json", "{}"),
  );
  assert.equal(
    fs.readFileSync(input.GITHUB_OUTPUT, "utf8"),
    "receipt-path=.buildchain/observed-evidence/receipt.json\n",
  );
});
test("observed evidence admits the default branch before source checkout and rejects pull requests", (t) => {
  const workflow = YAML.parse(
    fs.readFileSync(
      path.join(root, ".github/workflows/public-ops-observed-evidence.yml"),
      "utf8",
    ),
  );
  const steps = workflow.jobs.publish.steps;
  assert.equal(
    steps[1].uses,
    "./.buildchain/workflow-shell/actions/observability/admit-evidence-publisher",
  );
  assert.equal(steps[2].with.ref, "${{ github.sha }}");
  assert.equal(
    steps[4].with["source-checkout-outcome"],
    "${{ steps.source-checkout.outcome }}",
  );
  const action = YAML.parse(
    fs.readFileSync(
      path.join(
        root,
        "actions/observability/admit-evidence-publisher/action.yml",
      ),
      "utf8",
    ),
  );
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "observed-admit-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const [event, ref, ok] of [
    ["schedule", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/main", true],
    ["pull_request", "refs/heads/main", false],
    ["workflow_dispatch", "refs/heads/feature/test", false],
  ]) {
    const result = spawnSync("bash", ["-e", "-c", action.runs.steps[0].run], {
      cwd,
      env: {
        ...process.env,
        DEFAULT_BRANCH: "main",
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: ref,
      },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, ok);
  }
  const publication = YAML.parse(
    fs.readFileSync(
      path.join(root, "actions/observability/publish-evidence/action.yml"),
      "utf8",
    ),
  );
  const before = publication.runs.steps.findIndex(
    (s) => s.name === "Verify caller evidence semantics",
  );
  const credentials = publication.runs.steps.findIndex((s) =>
    s.uses?.startsWith("aws-actions/configure-aws-credentials@"),
  );
  assert.ok(before < credentials);
});
