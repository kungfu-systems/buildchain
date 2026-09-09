import { exactRemoteBranch } from "../packages/core/providers/git-ref-readback.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validatePropagationMode,
  selectPropagationTarget,
  resolvePropagationBranch,
  writePropagationLock,
} from "../packages/core/release/nodes/propagation-plan.mjs";
import {

  writePropagation,
  readPropagation,
} from "../packages/core/release/nodes/propagation-io.mjs";
import {
  uniquePropagationPr,
  openPropagationPr,
} from "../packages/core/release/nodes/propagation-pull-request.mjs";
import { recordMaterialization } from "../packages/core/release/nodes/propagation-work.mjs";
import {
  planReleasePropagation,
  createReleasePropagationWork,
} from "../packages/core/release/release-propagation.js";
import { propagationWorkContext } from "./helpers/propagation-work.mjs";
const sha = "a".repeat(40);
const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(
        `../fixtures/release-propagation-shaped/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
function localWorkspace(fn) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-propagation-node-"),
  );
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function planFixture() {
  return planReleasePropagation({
    graph: fixture("graph.json"),
    upstreamRelease: fixture("upstream-alpha.json"),
  });
}
function inputFor(target) {
  return {
    "downstream-target": target.target,
    "downstream-repository": target.repository,
    "downstream-base-ref": target.baseRef,
    "agent-work-mode": "capture-only",
    "dry-run": false,
    "pr-title": "chore: consume upstream release",
    "pr-body": "literal `body` $(never)",
  };
}
function readyWork(env, plan, input) {
  const work = createReleasePropagationWork({
    plan,
    target: input["downstream-target"],
    expectedDownstreamBaseSha: sha,
    workContext: propagationWorkContext(),
  });
  writePropagation("work.json", work, env);
  const target = selectPropagationTarget(plan, input);
  writePropagation(
    "write-lock.json",
    { lockSha256: target.lock.lockSha256 },
    env,
  );
  recordMaterialization(env);
  return readPropagation("work.json", env);
}
test("propagation execution requires an explicit matching Work authority; obsolete mode has no fallback", () => {
  assert.equal(
    validatePropagationMode({ "agent-work-mode": "capture-only" }),
    undefined,
  );
  assert.throws(
    () => validatePropagationMode({ "agent-work-mode": "legacy" }),
    /must be/,
  );
  assert.throws(
    () => validatePropagationMode({ "agent-work-mode": "execute" }),
    /exact authorized Work/,
  );
  assert.throws(
    () =>
      validatePropagationMode({
        "agent-work-mode": "capture-only",
        "agent-work-context-json": JSON.stringify(propagationWorkContext()),
      }),
    /modes disagree/,
  );
  assert.equal(
    validatePropagationMode({
      "agent-work-mode": "execute",
      "agent-work-context-json": JSON.stringify(propagationWorkContext()),
    }).authority.mode,
    "execute",
  );
});
test("propagation graph selection rejects duplicate targets and caller coordinate substitution", () => {
  const plan = planFixture(),
    target = plan.targets[0],
    input = inputFor(target);
  assert.equal(selectPropagationTarget(plan, input), target);
  assert.throws(
    () =>
      selectPropagationTarget({ ...plan, targets: [target, target] }, input),
    /exactly once/,
  );
  assert.throws(
    () =>
      selectPropagationTarget(plan, { ...input, "downstream-branch": "other" }),
    /coordinates disagree/,
  );
});
test("remote lookup preserves authentication failure and never creates a branch after it", () =>
  localWorkspace((root) => {
    const plan = planFixture(),
      target = plan.targets[0],
      input = inputFor(target),
      env = {
        GITHUB_WORKSPACE: root,
        BUILDCHAIN_PROPAGATION_REQUEST_JSON: JSON.stringify(input),
      };
    writePropagation("plan.json", plan, env);
    const calls = [];
    assert.throws(
      () =>
        resolvePropagationBranch(env, (program, args) => {
          calls.push(args);
          if (args[0] === "ls-remote") {
            const error = new Error("provider rejected credentials");
            error.status = 128;
            throw error;
          }
          return args[0] === "rev-parse" ? sha : "";
        }),
      (error) => error.status === 128,
    );
    assert.ok(!calls.some((args) => args[0] === "checkout"));
    assert.throws(
      () =>
        exactRemoteBranch("x", (_, args) =>
          args[0] === "check-ref-format" ? "" : `${sha}\trefs/heads/other`,
        ),
      /exact ref/,
    );
  }));
test("capture-only Work cannot materialize a downstream release lock", () =>
  localWorkspace((root) => {
    const plan = planFixture(),
      target = plan.targets[0],
      input = inputFor(target),
      env = {
        GITHUB_WORKSPACE: root,
        BUILDCHAIN_PROPAGATION_REQUEST_JSON: JSON.stringify(input),
      };
    writePropagation(
      "work.json",
      createReleasePropagationWork({
        plan,
        target: target.target,
        expectedDownstreamBaseSha: sha,
      }),
      env,
    );
    assert.throws(() => writePropagationLock(env), /does not authorize/);
    assert.ok(!fs.existsSync(path.join(root, "downstream")));
  }));
test("duplicate PRs and provider failures are rejected before any Git mutation", () =>
  localWorkspace((root) => {
    const plan = planFixture(),
      target = plan.targets[0],
      input = inputFor(target),
      env = {
        GITHUB_WORKSPACE: root,
        BUILDCHAIN_PROPAGATION_REQUEST_JSON: JSON.stringify(input),
        BUILDCHAIN_PROPAGATION_PLAN_JSON: JSON.stringify({
          lock_path: target.lockPath,
        }),
        BUILDCHAIN_PROPAGATION_BRANCH_JSON: JSON.stringify({ base_sha: sha }),
      };
    readyWork(env, plan, input);
    writePropagation("plan.json", plan, env);
    const calls = [];
    assert.throws(
      () =>
        openPropagationPr(env, {
          execute: (program, args) => {
            calls.push([program, args]);
            return program === "git"
              ? target.branch
              : JSON.stringify([
                  { number: 1, url: "https://github.com/a/b/pull/1" },
                  { number: 2, url: "https://github.com/a/b/pull/2" },
                ]);
          },
        }),
      /duplicate/,
    );
    assert.ok(
      !calls.some(([, args]) => ["add", "commit", "push"].includes(args[0])),
    );
    assert.throws(
      () => uniquePropagationPr([{ number: 0, url: "" }]),
      /invalid/,
    );
  }));
test("native propagation records real push evidence only after successful non-force provider readback", () =>
  localWorkspace((root) => {
    const plan = planFixture(),
      target = plan.targets[0],
      input = inputFor(target),
      env = {
        GITHUB_WORKSPACE: root,
        BUILDCHAIN_PROPAGATION_REQUEST_JSON: JSON.stringify(input),
        BUILDCHAIN_PROPAGATION_PLAN_JSON: JSON.stringify({
          lock_path: target.lockPath,
        }),
        BUILDCHAIN_PROPAGATION_BRANCH_JSON: JSON.stringify({ base_sha: sha }),
      };
    readyWork(env, plan, input);
    writePropagation("plan.json", plan, env);
    const calls = [],
      records = [];
    const execute = (program, args) => {
      calls.push([program, args]);
      if (program === "gh") {
        if (args[1] === "list") return "[]";
        throw Error("PR mutation occurred before push");
      }
      if (args[0] === "branch") return target.branch;
      if (args[0] === "rev-parse") return sha;
      if (args[0] === "ls-remote") return "";
      if (args[0] === "diff") return "release-lock.json\0";
      return "";
    };
    assert.throws(
      () =>
        openPropagationPr(env, {
          execute,
          push: () => {
            const error = new Error("remote changed");
            error.status = 1;
            throw error;
          },
          record: (...args) => records.push(args),
        }),
      /remote changed/,
    );
    assert.equal(records.length, 0);
    assert.ok(
      !fs.existsSync(
        path.join(root, ".buildchain/release-propagation/push-result.json"),
      ),
    );
    assert.ok(
      !calls.some(
        ([, args]) =>
          args.includes("config") ||
          args.some((arg) => arg.startsWith("--force")),
      ),
    );
    assert.ok(calls.some(([, args]) => args.includes("--signoff")));
  }));
