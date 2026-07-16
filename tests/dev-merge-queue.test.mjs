import assert from "node:assert/strict";
import test from "node:test";
import {
  createDevMergeQueuePlan,
  reconcileDevMergeQueue,
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
  });
  assert.equal(plan.operations[0].method, "POST");
  assert.equal(plan.operations[0].body.rules[0].type, "merge_queue");
  assert.deepEqual(plan.operations[0].body.conditions.ref_name.include, ["refs/heads/dev/v4/v4.0"]);
  assert.equal(plan.operations[1].body.strict, false);
  assert.deepEqual(plan.operations[1].body.checks, protection.required_status_checks.checks);
});

test("merge queue apply is idempotent and preserves operation order", async () => {
  const calls = [];
  const api = {
    async request(method, endpoint, body) {
      calls.push({ method, endpoint, body });
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
