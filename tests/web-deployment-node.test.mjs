import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { exactWebPlan, selectWebOutputs } from "../packages/core/web/deployment/plan-files.js";
import { admitGithubGovernanceReceipt } from "../packages/core/governance/receipt-admission.js";
import { selectGithubToken } from "../packages/core/providers/github-token.js";
import { deploymentSummary } from "../packages/core/web/deployment/summary.js";
import { commentPreviewResult } from "../packages/core/web/preview-feedback.js";
import { upsertIssueComment } from "../packages/core/providers/github-issue-comment.js";
const root = process.cwd();
function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "web-deploy-node-"));
  process.chdir(cwd);
  t.after(() => {
    process.chdir(root);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  fs.mkdirSync(".buildchain/downloaded-plans", { recursive: true });
  return cwd;
}
test("Web deployment requires a unique regular plan", (t) => {
  workspace(t);
  fs.writeFileSync(
    ".buildchain/downloaded-plans/web-surface-production-plan.json",
    "{}",
  );
  assert.ok(exactWebPlan(".buildchain/downloaded-plans", "web-surface-production-plan.json").endsWith("web-surface-production-plan.json"));
  fs.mkdirSync(".buildchain/downloaded-plans/duplicate");
  fs.writeFileSync(
    ".buildchain/downloaded-plans/duplicate/web-surface-production-plan.json",
    "{}",
  );
  assert.throws(
    () => exactWebPlan(".buildchain/downloaded-plans", "web-surface-production-plan.json"),
    /exactly one.*found 2/,
  );
  assert.throws(
    () =>
      exactWebPlan(
        ".buildchain/downloaded-plans",
        "web-surface-preview-plan.json",
      ),
    /found 0/,
  );
});
test("Web output selection rejects stale competing plans", (t) => {
  const cwd = workspace(t);
  assert.deepEqual(selectWebOutputs(), {});
  fs.writeFileSync(
    ".buildchain/web-surface-preview-plan.json",
    JSON.stringify({
      channel: "preview",
      alias: "pr-7",
      url: "https://preview.example",
    }),
  );
  assert.equal(selectWebOutputs()["web-surface-alias"], "pr-7");
  fs.writeFileSync(".buildchain/web-surface-staging-plan.json", "{}");
  assert.throws(() => selectWebOutputs(), /Multiple Web/);

});
test("Governance rejects stale checkout before admitting the receipt", () => {
  assert.throws(() => admitGithubGovernanceReceipt({receipt:{}, runtimeSha:"a".repeat(40)}, () => "b".repeat(40)), /does not match/);
  assert.throws(() => admitGithubGovernanceReceipt({}, () => assert.fail("must reject missing receipt first")), /fresh GitHub governance receipt/);
});
test("Credential selection keeps failed or partial App creation explicit and never stores credentials in metadata", () => {
  const partial=selectGithubToken({clientConfigured:true,privateKeyConfigured:false,fallbackToken:"fallback-secret",workflowToken:"workflow-secret"});
  assert.equal(partial.metadata.appStatus,"missing-private-key");assert.equal(partial.token,"fallback-secret");
  const failed=selectGithubToken({clientConfigured:true,privateKeyConfigured:true,appOutcome:"failure",appToken:"partial-secret",workflowToken:"workflow-secret"});
  assert.equal(failed.metadata.appStatus,"create-failed");assert.equal(failed.token,"workflow-secret");assert.equal(failed.metadata.appUnavailable,true);
  const available=selectGithubToken({clientConfigured:true,privateKeyConfigured:true,appOutcome:"success",appToken:"app-secret",fallbackToken:"fallback-secret"});
  assert.equal(available.token,"app-secret");assert.equal(available.metadata.source,"app");
  for(const selection of [partial,failed,available]) assert.doesNotMatch(JSON.stringify(selection.metadata),/secret/);
});
test("Web feedback preserves deployment coordinates and updates the existing preview comment", async (t) => {
  workspace(t);
  fs.writeFileSync(
    ".buildchain/web-surface-preview-apply.json",
    JSON.stringify({
      urls: { site: "https://preview.example" },
      sourceSha: "a".repeat(40),
      artifactHash: "sha256:fixture",
      status: "success",
    }),
  );
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (!options.method) return {ok:true, json:async () => [{ id:7, body:"<!-- buildchain:web-surface-preview -->" }]};
    calls.push({url, ...options});
    return {ok:true};
  };
  await commentPreviewResult({
    result: JSON.parse(fs.readFileSync(".buildchain/web-surface-preview-apply.json", "utf8")),
    cleanup: false, runUrl: "https://github.com/test/site/actions/runs/12", repository:"test/site", pullNumber:1, token:"test-token",
  }, {comment: request => upsertIssueComment({...request, fetchImpl})});
  assert.match(calls[0].url, /comments\/7$/);
  assert.equal(calls[0].method, "PATCH");
  assert.match(JSON.parse(calls[0].body).body, /https:\/\/preview.example/);
  assert.match(deploymentSummary("preview"), /health: missing/);
});
test("Web deployment keeps credential and failure boundaries in jobs while tokens use secret ports", () => {
  const workflow = YAML.parse(
    fs.readFileSync(
      path.join(root, ".github/workflows/public-release-web.yml"),
      "utf8",
    ),
  );
  assert.equal(
    workflow.on.workflow_call.inputs["production-release-pr-token"],
    undefined,
  );
  assert.equal(
    workflow.on.workflow_call.inputs["production-release-app-id"],
    undefined,
  );
  assert.ok(workflow.on.workflow_call.secrets["production-release-pr-token"]);
  for (const phase of ["preview-apply", "staging-apply", "production-apply"]) {
    assert.equal(workflow.jobs[phase].permissions["id-token"], "write");
    const action = YAML.parse(
      fs.readFileSync(
        path.join(root, `actions/web/${phase.replace("-apply", "")}/deploy/action.yml`),
        "utf8",
      ),
    );
    const credentials = action.runs.steps.findIndex((s) =>
      s.uses?.endsWith("/actions/providers/aws/configure"),
    );
    const apply = action.runs.steps.findIndex((s) => s.id === "apply");
    assert.ok(credentials >= 0 && credentials < apply);
    const feedback = action.runs.steps.find((s) => s.env?.JOB_STATUS);
    if (feedback) {
      assert.match(feedback.env.JOB_STATUS, /cancelled\(\).*failure\(\)/);
      assert.equal(action.inputs["job-status"], undefined);
    }
    assert.equal(action.runs.steps[0].id, "source-boundary");
  }
  const pr = YAML.parse(
    fs.readFileSync(
      path.join(root, "actions/web/production/open-release-pr/action.yml"),
      "utf8",
    ),
  );
  assert.ok(pr.inputs["secrets-production-release-pr-token"]);
});
