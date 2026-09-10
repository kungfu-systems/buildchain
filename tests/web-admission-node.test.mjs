import test from "node:test";
import assert from "node:assert/strict";
import { resolveWebRuntime } from "./helpers/runtime-selection.mjs";
import { resolveReleaseIntent } from "../packages/core/web/production-intent.js";
const sha = "a".repeat(40);
const env = {
  BUILDCHAIN_REPOSITORY: "kungfu-systems/buildchain",
  BUILDCHAIN_WORKFLOW_SHA: sha,
  BUILDCHAIN_WORKFLOW_REF:
    "kungfu-systems/buildchain/.github/workflows/public-release-web.yml@v4",
};
const context = {
  eventName: "pull_request",
  payload: { action: "opened" },
  repo: { owner: "consumer", repo: "web" },
  sha: "b".repeat(40),
  actor: "actor",
};
function recorder() {
  const values = {};
  const summary = {
    addHeading() {
      return this;
    },
    addRaw() {
      return this;
    },
    async write() {},
  };
  return {
    values,
    core: { setOutput: (key, value) => (values[key] = value), summary },
  };
}
test("Web runtime defaults to exact workflow bytes while retaining channel classification", async () => {
  const { values, core } = recorder();
  await resolveWebRuntime({ env, context, core, github: {} });
  assert.equal(values["runtime-ref"], sha);
  assert.equal(values["runtime-sha"], sha);
  assert.equal(values["runtime-class"], "stable");
  assert.equal(values["rollback-ref"], sha);
  assert.equal(values["runtime-override"], "false");
  await assert.rejects(
    resolveWebRuntime({
      env: { ...env, BUILDCHAIN_WORKFLOW_SHA: "" },
      context,
      core,
    }),
    /exact defining/,
  );
  await assert.rejects(
    resolveWebRuntime({
      env: {
        ...env,
        BUILDCHAIN_WORKFLOW_REF: "other/repo/.github/workflows/web.yml@v4",
      },
      context,
      core,
    }),
    /defining workflow repository/,
  );
});
test("Web overrides reject historical channels and unauthorized dispatches", async () => {
  const { core } = recorder();
  await assert.rejects(
    resolveWebRuntime({
      env: { ...env, BUILDCHAIN_REQUESTED_REF: "v3" },
      context,
      core,
    }),
    /current v4/,
  );
  await assert.rejects(
    resolveWebRuntime({
      env: { ...env, BUILDCHAIN_REQUESTED_REF: "c".repeat(40) },
      context,
      core,
    }),
    /workflow_dispatch/,
  );
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: "read" },
        }),
      },
    },
  };
  await assert.rejects(
    resolveWebRuntime({
      env: { ...env, BUILDCHAIN_REQUESTED_REF: "train/v4/v4.1/web" },
      context: { ...context, eventName: "workflow_dispatch" },
      core,
      github,
    }),
    /write permission/,
  );
  const { values, core: closedCore } = recorder();
  await resolveWebRuntime({
    env: { ...env, BUILDCHAIN_REQUESTED_REF: sha },
    context: { ...context, payload: { action: "closed" } },
    core: closedCore,
  });
  assert.equal(
    values["runtime-trust-decision"],
    "closed-release-pr-shell-runtime",
  );
});
test("Web current channel resolves a commit and preserves provider authorization errors", async () => {
  const { values, core } = recorder();
  const github = {
    rest: {
      repos: { getCommit: async () => ({ data: { sha: "c".repeat(40) } }) },
    },
  };
  await resolveWebRuntime({
    env: { ...env, BUILDCHAIN_REQUESTED_REF: "v4-alpha" },
    context,
    core,
    github,
  });
  assert.equal(values["runtime-class"], "alpha");
  assert.equal(values["runtime-sha"], "c".repeat(40));
  github.rest.repos.getCommit = async () => {
    throw Object.assign(new Error("denied"), { status: 403 });
  };
  await assert.rejects(
    resolveWebRuntime({
      env: { ...env, BUILDCHAIN_REQUESTED_REF: "v4-alpha" },
      context,
      core,
      github,
    }),
    (e) => e.status === 403,
  );
});
test("Web production intent requires explicit dispatch approval for an exact requested source", async () => {
  const request = {
    "production-source-sha": sha,
    "production-approved": false,
  };
  const invocation = { ...context, eventName: "workflow_dispatch" };
  const { values, core } = recorder();
  await assert.rejects(
    resolveReleaseIntent({ request, context: invocation, core }),
    /explicitly approved/,
  );
  assert.equal(values["production-release-approved"], "false");
  await resolveReleaseIntent({
    request: {
      ...request,
      "production-approved": true,
      "production-environment": "production",
    },
    context: invocation,
    core,
  });
  assert.equal(values["production-source-sha"], sha);
  assert.equal(values["production-release-approved"], "true");
});
test("Web release intent rejects ambiguous merged PRs and filters foreign heads", async () => {
  const { values, core } = recorder();
  const input = {
    "production-release-on-main": true,
    "production-release-label": "release",
    "production-release-head-prefix": "web-release/",
  };
  const invocation = { ...context, eventName: "push", ref: "refs/heads/main" };
  const pull = {
    number: 1,
    labels: [{ name: "release" }],
    head: { repo: { full_name: "consumer/web" }, ref: "web-release/current" },
    base: { ref: "main" },
    merged_at: "2026-09-09T00:00:00Z",
    merge_commit_sha: sha,
  };
  const github = {
    paginate: async () => [pull, { ...pull, number: 2 }],
    rest: { repos: { listPullRequestsAssociatedWithCommit() {} } },
  };
  await assert.rejects(
    resolveReleaseIntent({ request: input, context: invocation, core, github }),
    /multiple associated/,
  );
  github.paginate = async () => [
    { ...pull, head: { ...pull.head, repo: { full_name: "other/repo" } } },
  ];
  await resolveReleaseIntent({ request: input, context: invocation, core, github });
  assert.equal(values["production-release-approved"], "false");
});

test("Web apply gate uses the trusted decision and validates roles before a build", async () => {
  const { admitWebApplyInputs } = await import("../packages/core/web/apply-admission.js");
  for (const input of [
    {event:{name:"pull_request",action:"opened"}, request:{"preview-apply":true}},
    {event:{name:"pull_request",action:"closed"}, request:{"preview-cleanup-apply":true}},
    {event:{name:"push",refName:"main"}, request:{"staging-apply":true}},
    {event:{name:"workflow_dispatch"}, request:{"production-apply":true}, decisionApproved:true},
  ]) assert.throws(() => admitWebApplyInputs(input), /role-arn is required/);
  assert.deepEqual(admitWebApplyInputs({event:{name:"workflow_dispatch"},request:{"production-approved":true}}),
    {"web-surface-channel":"staging","web-surface-alias":""});
  assert.deepEqual(admitWebApplyInputs({event:{name:"pull_request",action:"closed"}}),
    {"web-surface-channel":"","web-surface-alias":""});
  assert.deepEqual(admitWebApplyInputs({event:{name:"pull_request",pullNumber:12}}),
    {"web-surface-channel":"preview","web-surface-alias":"pr-12"});
  assert.equal(admitWebApplyInputs({event:{name:"pull_request",action:"closed"},decisionApproved:true})["web-surface-channel"],"production");
  assert.throws(()=>admitWebApplyInputs({event:{name:"pull_request",pullNumber:"12\nchannel=production"}}),/exact pull request/);
});
