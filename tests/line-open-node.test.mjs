import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { planReleaseLineBootstrap } from "../packages/core/release/release-line-bootstrap.js";
import {
  lineProtection,
  protectLine,
  openLineAlphaPr,
  setLineDefault,
} from "../packages/core/release/nodes/line-open-governance.mjs";
import {
  statePath,
  writeState,
  writeLine,
  commitAndPushLine,
} from "../packages/core/release/nodes/line-open-workspace.mjs";
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "line-node-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fixture", version: "4.0.10" }),
  );
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "package.json"], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd },
  );
  const plan = planReleaseLineBootstrap({
    cwd,
    major: 4,
    minor: 1,
    sourceRef: "release/v4/v4.0",
    setDefault: false,
    createAlphaPr: false,
  });
  const env = {
    RUNNER_TEMP: cwd,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_REPOSITORY: "fixture/repo",
    GH_TOKEN: "non-secret-test-value",
    BUILDCHAIN_APPLY: "true",
  };
  writeState(env, "plan", plan);
  return { cwd, plan, env };
}
test("release line provider bodies match the planned channel policies", (t) => {
  const { plan, env } = fixture(t);
  const calls = [];
  protectLine(env, (...args) => calls.push(args));
  assert.equal(calls.length, 3);
  for (const [index, channel] of ["dev", "alpha", "release"].entries()) {
    const body = JSON.parse(calls[index][2].input);
    assert.deepEqual(body, lineProtection(plan, channel));
    assert.equal(body.required_status_checks.strict, channel === "release");
    assert.deepEqual(
      body.required_status_checks.checks.map((x) => x.context),
      channel === "alpha" ? ["check", "verify"] : ["check"],
    );
    assert.equal(
      body.required_pull_request_reviews.required_approving_review_count,
      1,
    );
    assert.equal(
      body.required_pull_request_reviews.require_last_push_approval,
      true,
    );
    assert.ok(
      calls[index][1].includes(
        `repos/fixture/repo/branches/${encodeURIComponent(plan.refs[channel])}/protection`,
      ),
    );
  }
});
test("every provider effect rejects dry-run and unplanned optional effects", (t) => {
  const { env } = fixture(t);
  const fail = () => assert.fail("unexpected provider write");
  for (const operation of [
    protectLine,
    openLineAlphaPr,
    setLineDefault,
    commitAndPushLine,
    writeLine,
  ]) {
    assert.throws(
      () => operation({ ...env, BUILDCHAIN_APPLY: "false" }, fail),
      /apply=true/,
    );
  }
  assert.throws(() => setLineDefault(env, fail), /not planned/);
  assert.throws(() => openLineAlphaPr(env, fail), /not planned/);
});
test("version commit stages only declared output files and preserves alpha/release source SHA", (t) => {
  const { plan, env } = fixture(t);
  writeState(env, "write", {
    ...plan,
    changedFiles: ["package.json", "dist/site/manifest.json"],
  });
  const calls = [];
  commitAndPushLine(env, (...args) => calls.push(args));
  assert.deepEqual(calls[0], [
    "git",
    ["add", "--", "package.json", "dist/site/manifest.json"],
  ]);
  assert.equal(calls[1][1].includes("config"), false);
  assert.equal(calls[1][1].includes("-s"), true);
  assert.deepEqual(
    calls.slice(2).map((x) => x[1].at(-1)),
    [
      `HEAD:refs/heads/${plan.refs.bootstrap}`,
      `HEAD:refs/heads/${plan.refs.dev}`,
      `${plan.source.sha}:refs/heads/${plan.refs.alpha}`,
      `${plan.source.sha}:refs/heads/${plan.refs.release}`,
    ],
  );
  assert.equal(
    calls.some((x) => x[1].includes("--force")),
    false,
  );
});
test("source drift is rejected before version-state generation", (t) => {
  const { env } = fixture(t);
  assert.throws(() => writeLine(env, () => "f".repeat(40)), /Source changed/);
  assert.throws(
    () => statePath({ ...env, GITHUB_RUN_ID: "../escape" }, "plan"),
    /Exact workflow/,
  );
});
