import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  HOUSEKEEPER_REASON_CODES,
  classifyHousekeeperBranch,
  classifyHousekeeperPullRequest,
  classifyHousekeeperReplay,
  createEngineeringHousekeeperPlan,
  createEngineeringHousekeeperReceipt,
  revalidateHousekeeperBranchAction,
} from "../packages/core/engineering-housekeeper.js";

const oid = (value) => String(value).repeat(40).slice(0, 40);
const target = { name: "dev/v3/v3.0", headOid: oid("b") };
const branch = (overrides = {}) => ({
  repository: "kungfu-systems/buildchain",
  sourceRepository: "kungfu-systems/buildchain",
  name: "feature/merged",
  headOid: oid("a"),
  target,
  ancestry: "ancestor",
  openPullRequestNumbers: [],
  ...overrides,
});

test("fixtures cover all required safety classes", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/fixtures/engineering-housekeeper-v1/cases.json",
        import.meta.url,
      ),
    ),
  );
  assert.deepEqual(
    fixture.cases.map((entry) => entry.id),
    [
      "active",
      "merged",
      "stale",
      "advanced",
      "renamed",
      "protected",
      "forked",
      "permission-denied",
      "repeated",
    ],
  );
  for (const entry of fixture.cases.filter((candidate) => candidate.branch)) {
    const result = classifyHousekeeperBranch(branch(entry.branch));
    assert.equal(result.eligible, entry.eligible, entry.id);
    assert.ok(result.reasonCodes.includes(entry.reason), entry.id);
  }
});

test("branch deletion requires exact ancestry, no open PR, and no protected or retained match", () => {
  assert.equal(classifyHousekeeperBranch(branch()).eligible, true);
  assert.equal(
    classifyHousekeeperBranch(branch({ name: "train/v3/v3.0/demo" })).eligible,
    false,
  );
  assert.equal(
    classifyHousekeeperBranch(branch({ ancestry: "diverged" })).eligible,
    false,
  );
  assert.equal(
    classifyHousekeeperBranch(branch({ openPullRequestNumbers: [3] })).eligible,
    false,
  );
});

test("apply-time revalidation rejects advanced, renamed, target-advanced, and newly active branches", () => {
  const plan = createEngineeringHousekeeperPlan({
    repository: branch().repository,
    target,
    branches: [branch()],
    observedAt: "2026-08-09T13:00:00Z",
  });
  const action = plan.actions[0];
  assert.equal(revalidateHousekeeperBranchAction(action, branch()).ok, true);
  assert.ok(
    revalidateHousekeeperBranchAction(
      action,
      branch({ headOid: oid("c") }),
    ).reasonCodes.includes(HOUSEKEEPER_REASON_CODES.HEAD_ADVANCED),
  );
  assert.ok(
    revalidateHousekeeperBranchAction(
      action,
      branch({ name: "feature/renamed" }),
    ).reasonCodes.includes(HOUSEKEEPER_REASON_CODES.RENAMED),
  );
  assert.ok(
    revalidateHousekeeperBranchAction(
      action,
      branch({ target: { ...target, headOid: oid("d") } }),
    ).reasonCodes.includes(HOUSEKEEPER_REASON_CODES.TARGET_ADVANCED),
  );
  assert.ok(
    revalidateHousekeeperBranchAction(
      action,
      branch({ openPullRequestNumbers: [9] }),
    ).reasonCodes.includes(HOUSEKEEPER_REASON_CODES.OPEN_PR_HEAD),
  );
});

test("pull request hygiene can report or label but never auto-close", () => {
  const result = classifyHousekeeperPullRequest(
    {
      repository: branch().repository,
      number: 8,
      state: "open",
      stale: true,
      headRepository: branch().repository,
      headRef: "feature/stale",
      headOid: oid("a"),
    },
    { pullRequests: { label: "stale" } },
  );
  assert.deepEqual(result.actions, ["label", "report"]);
  assert.ok(
    result.reasonCodes.includes(
      HOUSEKEEPER_REASON_CODES.PR_AUTO_CLOSE_DISABLED,
    ),
  );
  assert.ok(!result.actions.includes("close"));
});

test("plans and receipts are deterministic and repeated plans are no-ops", () => {
  const input = {
    repository: branch().repository,
    target,
    branches: [branch()],
    observedAt: "2026-08-09T13:00:00Z",
  };
  const plan = createEngineeringHousekeeperPlan(input);
  assert.deepEqual(plan, createEngineeringHousekeeperPlan(input));
  const receipt = createEngineeringHousekeeperReceipt({
    plan,
    outcomes: [{ action: "delete-branch", status: "deleted" }],
    appliedAt: "2026-08-09T13:01:00Z",
  });
  assert.deepEqual(
    receipt,
    createEngineeringHousekeeperReceipt({
      plan,
      outcomes: [{ action: "delete-branch", status: "deleted" }],
      appliedAt: "2026-08-09T13:01:00Z",
    }),
  );
  assert.deepEqual(classifyHousekeeperReplay(plan, receipt).reasonCodes, [
    HOUSEKEEPER_REASON_CODES.REPEATED_NO_OP,
  ]);
});

test("plan and receipt conform to the public contract schema", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/engineering-housekeeper-v1.schema.json",
        import.meta.url,
      ),
    ),
  );
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  const plan = createEngineeringHousekeeperPlan({
    repository: branch().repository,
    target,
    branches: [branch()],
    observedAt: "2026-08-09T13:00:00Z",
  });
  const receipt = createEngineeringHousekeeperReceipt({
    plan,
    outcomes: [],
    appliedAt: "2026-08-09T13:01:00Z",
  });
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
});
