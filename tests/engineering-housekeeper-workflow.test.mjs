import { inspectWorkflowJob, readWorkflow } from "../scripts/workflow-action-graph.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { applyHousekeeperWorkflowScope, createHousekeeperWorkflowPlan, selectHousekeeperActions } from "../packages/core/governance/housekeeping/transactions.js";
import { normalizeHousekeeperWorkflowOptions } from "../packages/core/governance/housekeeping/options.js";
import { renderHousekeeperWorkflowReport } from "../packages/core/governance/housekeeping/report.js";

const repository = "kungfu-systems/buildchain";
const targetBranch = "dev/v3/v3.0";
const targetOid = "b".repeat(40);
const mergedOid = "a".repeat(40);
const staleOid = "c".repeat(40);

function clone(value) {
  return structuredClone(value);
}

class FakeClient {
  constructor() {
    this.branches = new Map([
      [
        targetBranch,
        { name: targetBranch, protected: true, commit: { sha: targetOid } },
      ],
      [
        "feature/merged",
        { name: "feature/merged", commit: { sha: mergedOid } },
      ],
    ]);
    this.pullRequests = [
      {
        number: 7,
        state: "open",
        draft: false,
        updated_at: "2026-01-01T00:00:00.000Z",
        head: {
          ref: "feature/stale",
          sha: staleOid,
          repo: { full_name: repository },
        },
        labels: [],
      },
    ];
    this.deleted = [];
    this.labels = [];
  }

  async getRepository() {
    return { default_branch: targetBranch };
  }

  async listBranches() {
    return [...this.branches.values()].map(clone);
  }

  async listOpenPullRequests() {
    return this.pullRequests
      .filter((entry) => entry.state === "open")
      .map(clone);
  }

  async listClosedPullRequests() {
    return [
      {
        number: 6,
        state: "closed",
        merged_at: "2026-08-01T00:00:00.000Z",
        head: {
          ref: "feature/merged",
          sha: mergedOid,
          repo: { full_name: repository },
        },
        base: { ref: targetBranch },
      },
    ];
  }

  async getBranch(_repository, name) {
    return clone(this.branches.get(name));
  }

  async compareCommits(_repository, baseOid) {
    return { merge_base_commit: { sha: baseOid } };
  }

  async getPullRequest(_repository, number) {
    return clone(this.pullRequests.find((entry) => entry.number === number));
  }

  async deleteBranch(_repository, name) {
    this.deleted.push(name);
    this.branches.delete(name);
  }

  async addLabels(_repository, number, labels) {
    this.labels.push({ number, labels });
    this.pullRequests
      .find((entry) => entry.number === number)
      .labels.push(...labels);
  }
}

function options(overrides = {}) {
  return {
    repository,
    targetBranch,
    observedAt: "2026-08-10T00:00:00.000Z",
    appliedAt: "2026-08-10T00:01:00.000Z",
    mode: "report",
    ...overrides,
  };
}

test("workflow options require an explicit positive apply gate", () => {
  assert.throws(
    () =>
      normalizeHousekeeperWorkflowOptions(
        options({ mode: "apply", applyEnabled: false }),
      ),
    /apply mode requires apply-enabled=true/,
  );
  assert.throws(
    () =>
      normalizeHousekeeperWorkflowOptions(
        options({ mode: "report", applyEnabled: true }),
      ),
    /only valid when mode=apply/,
  );
  assert.equal(
    normalizeHousekeeperWorkflowOptions(
      options({ mode: "apply", applyEnabled: true }),
    ).mode,
    "apply",
  );
  const repositoryWide = normalizeHousekeeperWorkflowOptions(
    options({ targetBranch: "" }),
  );
  assert.equal(repositoryWide.targetBranch, "");
  assert.deepEqual(repositoryWide.temporaryBranchPatterns, [
    "feature/**",
    "fix/**",
    "chore/**",
    "docs/**",
    "ci/**",
    "refactor/**",
  ]);
});

test("report plan is exact, rooted, default dry-run, and secret-free", async () => {
  const client = new FakeClient();
  const result = await createHousekeeperWorkflowPlan(
    options({ stalePullRequestLabel: "stale-housekeeping" }),
    client,
  );
  assert.equal(result.plan.repository, repository);
  assert.deepEqual(
    result.plan.actions.map((entry) => entry.kind),
    ["delete-branch", "label-pull-request", "report-pull-request"],
  );
  assert.ok(
    result.receipt.outcomes.every((entry) => entry.status === "dry-run"),
  );
  assert.deepEqual(client.deleted, []);
  assert.deepEqual(client.labels, []);
  const report = renderHousekeeperWorkflowReport(result.plan, result.receipt, {
    mode: "report",
  });
  assert.match(report, new RegExp(`${targetBranch}@${targetOid}`));
  assert.match(report, /feature\/merged/);
  assert.doesNotMatch(report, /token|private.?key/i);
});

test("apply scopes preserve global ordering and use disjoint permissions surfaces", async () => {
  const client = new FakeClient();
  const planned = await createHousekeeperWorkflowPlan(
    options({ stalePullRequestLabel: "stale-housekeeping" }),
    client,
  );
  assert.deepEqual(
    selectHousekeeperActions(planned.plan, "branches", 2).map(
      (entry) => entry.kind,
    ),
    ["delete-branch"],
  );
  assert.deepEqual(
    selectHousekeeperActions(planned.plan, "pull-requests", 2).map(
      (entry) => entry.kind,
    ),
    ["label-pull-request"],
  );
  const branch = await applyHousekeeperWorkflowScope({
    options: options({
      mode: "apply",
      applyEnabled: true,
      stalePullRequestLabel: "stale-housekeeping",
      maxActions: 2,
    }),
    plan: planned.plan,
    scope: "branches",
    client,
  });
  const pullRequest = await applyHousekeeperWorkflowScope({
    options: options({
      mode: "apply",
      applyEnabled: true,
      stalePullRequestLabel: "stale-housekeeping",
      maxActions: 2,
    }),
    plan: planned.plan,
    scope: "pull-requests",
    client,
  });
  assert.deepEqual(client.deleted, ["feature/merged"]);
  assert.deepEqual(client.labels, [
    { number: 7, labels: ["stale-housekeeping"] },
  ]);
  assert.equal(branch.receipt.outcomes[0].status, "deleted");
  assert.equal(pullRequest.receipt.outcomes[0].status, "labeled");
  assert.equal(branch.receipt.planRoot, planned.plan.planRoot);
  assert.equal(pullRequest.receipt.planRoot, planned.plan.planRoot);
});

test("reusable workflow exposes typed evidence outputs and separated job permissions", () => {
  const file = ".github/workflows/public-ops-housekeeping.yml", workflow = readWorkflow(file);
  const inputs = workflow.on.workflow_call.inputs;
  assert.equal(inputs.mode.default, "report");
  assert.equal(inputs["apply-enabled"].default, false);
  assert.equal(inputs["runtime-ref"].default, "");
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.plan.permissions, { contents: "read", "pull-requests": "read" });
  for (const id of ["delete-branches", "label-pull-requests"]) assert.equal(workflow.jobs[id].permissions, undefined);
  const plan = inspectWorkflowJob(file, "plan");
  assert.ok(plan.steps.some(step => step.uses?.startsWith("actions/create-github-app-token@")));
  for (const name of ["Upload exact plan", "Upload decision report", "Upload report receipt"])
    assert.ok(plan.steps.some(step => step.name === name));
  for (const field of ["plan-root", "report-receipt-root"]) assert.ok(workflow.on.workflow_call.outputs[field]);
  assert.doesNotMatch(JSON.stringify(workflow), /BUILDCHAIN_PROMOTION_TOKEN|secrets.github_/);
  for (const field of ["housekeeper_token", "housekeeper_app_id", "housekeeper_app_private_key"])
    assert.ok(workflow.on.workflow_call.secrets[field]);
});

test("daily, weekly, and monthly callers remain thin reusable workflow policy", () => {
  for (const cadence of ["daily", "weekly", "monthly"]) {
    const caller = fs.readFileSync(
      new URL(
        `../.github/workflows/self-ops-housekeeping-${cadence}.yml`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(caller, /schedule:/);
    assert.match(
      caller,
      /uses: kungfu-systems\/buildchain\/\.github\/workflows\/public-ops-housekeeping\.yml@v4/,
    );
    assert.match(caller, /mode: report/);
    assert.match(caller, /mode: apply/);
    assert.match(caller, /apply-enabled: true/);
    assert.match(caller, /github\.event_name == 'schedule'/);
    assert.match(
      caller,
      /report:[\s\S]*?permissions:\n      contents: read\n      pull-requests: read/,
    );
    assert.match(
      caller,
      /apply:[\s\S]*?permissions:\n      contents: write\n      pull-requests: write/,
    );
    assert.match(
      caller,
      /stale-pull-request-label: engineering-housekeeper:stale/,
    );
    assert.match(
      caller,
      /runtime-selection: \$\{\{ needs.execution-runtime.outputs.selection \}\}/,
    );
    assert.doesNotMatch(caller, /target-branch: dev\/v3\/v3\.0/);
    assert.doesNotMatch(caller, /engineering-housekeeper-workflow\.mjs/);
  }
});
