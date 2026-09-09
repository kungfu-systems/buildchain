import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  exactWebPlan,
  deploymentArguments,
  selectWebOutputs,
  verifyWebGovernance,
  writeOutputs,
} from "../packages/core/web/nodes/deployment-io.mjs";
import {
  webTokenConfig,
  webTokenSource,
} from "../packages/core/web/nodes/deployment-token.mjs";
import { deploymentSummary } from "../packages/core/web/nodes/deployment-summary.mjs";
import { commentDeployment as commentPreview } from "../packages/core/web/nodes/comment-preview-apply.mjs";
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
test("Web deployment requires a unique regular plan and passes working directories literally", (t) => {
  workspace(t);
  fs.writeFileSync(
    ".buildchain/downloaded-plans/web-surface-production-plan.json",
    "{}",
  );
  const env = {
    BUILDCHAIN_WEB_CHANNEL: "production",
    BUILDCHAIN_WEB_REQUEST_JSON: JSON.stringify({
      "working-directory": "site $(touch injected)",
    }),
    GITHUB_ACTOR: "actor",
    GITHUB_RUN_ID: "12",
  };
  const args = deploymentArguments(env, "deploy");
  assert.equal(args[args.indexOf("--cwd") + 1], "site $(touch injected)");
  assert.equal(args[args.indexOf("--dry-run") + 1], "false");
  assert.equal(args[args.indexOf("--mode") + 1], "deploy-apply");
  assert.equal(
    deploymentArguments(env, "preflight").includes("--execute"),
    true,
  );
  fs.mkdirSync(".buildchain/downloaded-plans/duplicate");
  fs.writeFileSync(
    ".buildchain/downloaded-plans/duplicate/web-surface-production-plan.json",
    "{}",
  );
  assert.throws(
    () => deploymentArguments(env, "deploy"),
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
test("Web output selection rejects stale competing plans and scalar output injection", (t) => {
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
  assert.throws(
    () =>
      writeOutputs(
        { GITHUB_OUTPUT: path.join(cwd, "output") },
        { alias: "pr-7\nchannel=production" },
      ),
    /line breaks/,
  );
});
test("Web governance rejects stale checkout before loading the verifier", async () => {
  await assert.rejects(
    verifyWebGovernance(
      {
        BUILDCHAIN_GITHUB_GOVERNANCE_RECEIPT_JSON: "{}",
        BUILDCHAIN_AUTHORITY_REF: "a".repeat(40),
      },
      () => "b".repeat(40),
    ),
    /does not match/,
  );
  await assert.rejects(
    verifyWebGovernance({}, () =>
      assert.fail("must reject missing receipt first"),
    ),
    /fresh GitHub governance receipt/,
  );
});
test("Web token metadata distinguishes missing App configuration and failed creation without storing credentials", () => {
  const config = webTokenConfig({
    PRODUCTION_RELEASE_APP_CLIENT_ID: "client",
    PRODUCTION_RELEASE_APP_PRIVATE_KEY_PRESENT: "false",
    PRODUCTION_RELEASE_PR_TOKEN_PRESENT: "true",
  });
  assert.equal(config["app-token-status"], "missing-private-key");
  assert.equal(config["app-token-requested"], "false");
  const failed = webTokenSource({
    APP_TOKEN_STATUS: "requested",
    APP_TOKEN_OUTCOME: "failure",
    APP_TOKEN_PRESENT: "false",
    PR_TOKEN_CONFIGURED: "true",
  });
  assert.deepEqual(failed, {
    "token-source": "production-release-pr-token",
    "app-token-status": "create-failed",
    "app-token-unavailable": "true",
  });
  assert.equal(
    webTokenSource({
      APP_TOKEN_STATUS: "requested",
      APP_TOKEN_OUTCOME: "success",
      APP_TOKEN_PRESENT: "true",
    })["token-source"],
    "github-app",
  );
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
  const github = {
    paginate: async () => [
      { id: 7, body: "<!-- buildchain:web-surface-preview -->" },
    ],
    rest: {
      issues: {
        listComments() {},
        updateComment: async (args) => calls.push(args),
        createComment() {
          assert.fail("must update existing");
        },
      },
    },
  };
  await commentPreview({
    github,
    context: {
      repo: { owner: "test", repo: "site" },
      payload: { pull_request: { number: 1 } },
      serverUrl: "https://github.com",
      runId: 12,
    },
  });
  assert.equal(calls[0].comment_id, 7);
  assert.match(calls[0].body, /https:\/\/preview.example/);
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
        path.join(root, `actions/web/web-${phase}/action.yml`),
        "utf8",
      ),
    );
    const credentials = action.runs.steps.findIndex((s) =>
      s.uses?.startsWith("aws-actions/configure-aws-credentials@"),
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
      path.join(root, "actions/web/web-open-production-release-pr/action.yml"),
      "utf8",
    ),
  );
  assert.ok(pr.inputs["secrets-production-release-pr-token"]);
});
