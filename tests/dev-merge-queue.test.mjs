import assert from "node:assert/strict";
import test from "node:test";
import {
  createDevMergeQueuePlan,
  reconcileDevMergeQueue,
  resolveRulesetBypassActors,
  selectMergeQueueMethod,
  validateMergeGroupWorkflows,
} from "../scripts/dev-merge-queue.mjs";

const workflows = [
  {
    path: ".github/workflows/source-acceptance.yml",
    source: "on:\n  pull_request:\n  merge_group:\n    types: [checks_requested]\n",
  },
];
const protection = {
  required_status_checks: {
    strict: true,
    checks: [{ context: "Source acceptance / check", app_id: 15368 }],
  },
};
const repositorySettings = {
  allow_merge_commit: false,
  allow_squash_merge: false,
  allow_rebase_merge: true,
};

test("merge queue selects only a repository-enabled merge method", () => {
  assert.equal(selectMergeQueueMethod(repositorySettings), "REBASE");
  assert.equal(selectMergeQueueMethod({ allow_squash_merge: true }), "SQUASH");
  assert.throws(
    () => selectMergeQueueMethod({}),
    /repository must allow at least one merge method/,
  );
});

test("merge queue rejects required workflows without merge_group", () => {
  assert.throws(
    () => validateMergeGroupWorkflows([{ path: "check.yml", source: "on:\n  pull_request:\n" }]),
    /requires pull_request and merge_group triggers/,
  );
  assert.throws(
    () => validateMergeGroupWorkflows([{
      path: "check.yml",
      source: "on:\n  pull_request:\n  merge_group:\nsteps:\n  - run: echo ${{ github.event.pull_request.head.sha }}\n",
    }]),
    /must not depend directly on github\.event\.pull_request/,
  );
});

test("merge queue plan creates an exact dev ruleset before loosening classic strict checks", () => {
  const plan = createDevMergeQueuePlan({
    repository: "kungfu-systems/kungfu",
    branch: "dev/v4/v4.0",
    workflows,
    protection,
    repositorySettings,
  });
  assert.equal(plan.operations[0].method, "POST");
  assert.equal(plan.operations[0].body.rules[0].type, "merge_queue");
  assert.deepEqual(plan.operations[0].body.conditions.ref_name.include, ["refs/heads/dev/v4/v4.0"]);
  assert.equal(plan.operations[0].body.rules[0].parameters.merge_method, "REBASE");
  assert.deepEqual(plan.operations[0].body.bypass_actors, []);
  assert.equal(plan.operations[1].body.strict, false);
  assert.deepEqual(plan.operations[1].body.checks, protection.required_status_checks.checks);
});

test("merge queue resolves only explicit app, user, and team bypass actors", async () => {
  const calls = [];
  const api = {
    async request(method, endpoint) {
      calls.push([method, endpoint]);
      if (endpoint === "apps/release-bot") return { id: 101 };
      if (endpoint === "users/release-owner") return { id: 202 };
      if (endpoint === "orgs/kungfu-systems/teams/release-engineering") return { id: 303 };
      throw new Error(`unexpected endpoint: ${endpoint}`);
    },
  };
  const actors = await resolveRulesetBypassActors({
    api,
    repository: "kungfu-systems/buildchain",
    apps: ["release-bot"],
    users: ["release-owner"],
    teams: ["release-engineering"],
  });
  assert.deepEqual(actors, [
    { actor_id: 101, actor_type: "Integration", bypass_mode: "always" },
    { actor_id: 202, actor_type: "User", bypass_mode: "always" },
    { actor_id: 303, actor_type: "Team", bypass_mode: "always" },
  ]);
  assert.deepEqual(calls, [
    ["GET", "apps/release-bot"],
    ["GET", "users/release-owner"],
    ["GET", "orgs/kungfu-systems/teams/release-engineering"],
  ]);
});

test("merge queue writes an exact promotion bypass without weakening PR admission", () => {
  const plan = createDevMergeQueuePlan({
    repository: "kungfu-systems/buildchain",
    branch: "dev/v2/v2.14",
    workflows,
    protection,
    repositorySettings,
    bypassActors: [{ actor_id: 202, actor_type: "User" }],
  });
  assert.deepEqual(plan.operations[0].body.bypass_actors, [
    { actor_id: 202, actor_type: "User", bypass_mode: "always" },
  ]);
  assert.equal(plan.operations[0].body.rules[0].type, "merge_queue");
  assert.equal(plan.operations[1].body.strict, false);
});

test("merge queue apply is idempotent and preserves operation order", async () => {
  const calls = [];
  const api = {
    async request(method, endpoint, body) {
      calls.push({ method, endpoint, body });
      if (method === "GET" && endpoint === "repos/kungfu-systems/kungfu") return repositorySettings;
      if (endpoint.endsWith("/protection")) return protection;
      if (method === "GET" && endpoint.includes("/rulesets?")) {
        return [{ id: 42, name: "Buildchain dev merge queue: dev/v4/v4.0" }];
      }
      if (method === "PUT") return { id: 42 };
      return {};
    },
  };
  const result = await reconcileDevMergeQueue({
    api,
    repository: "kungfu-systems/kungfu",
    branch: "dev/v4/v4.0",
    workflows,
    apply: true,
  });
  const mutations = calls.filter((call) => call.method !== "GET");
  assert.deepEqual(mutations.map((call) => call.method), ["PUT", "PATCH"]);
  assert.equal(result.action, "updated");
  assert.equal(result.applied, true);
  assert.equal(result.after.rulesetId, 42);
});
