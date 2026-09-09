import fs from "node:fs";
import path from "node:path";
import {
  planReleaseLineBootstrap,
  writeReleaseLineBootstrapVersionState,
} from "../release-line-bootstrap.js";
import { command, requireValue } from "../../runtime/action-process.mjs";

export function statePath(env, name) {
  requireValue(
    Boolean(env.RUNNER_TEMP),
    "Release line state requires RUNNER_TEMP",
  );
  requireValue(
    /^\d+$/.test(env.GITHUB_RUN_ID || "") &&
      /^\d+$/.test(env.GITHUB_RUN_ATTEMPT || ""),
    "Exact workflow run coordinates are required",
  );
  return path.join(
    env.RUNNER_TEMP,
    `buildchain-line-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${name}.json`,
  );
}
export function readPlan(env) {
  return JSON.parse(fs.readFileSync(statePath(env, "plan"), "utf8"));
}
export function writeState(env, name, value) {
  fs.writeFileSync(statePath(env, name), `${JSON.stringify(value, null, 2)}\n`);
}
export function planLine(env, execute = command) {
  const status = execute(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { stdio: "pipe" },
  );
  requireValue(
    !status.trim(),
    "Release line bootstrap requires a clean source checkout",
  );
  const plan = planReleaseLineBootstrap({
    major: env.BUILDCHAIN_MAJOR,
    minor: env.BUILDCHAIN_MINOR,
    sourceRef: env.BUILDCHAIN_SOURCE_REF,
    initialVersion: env.BUILDCHAIN_INITIAL_VERSION,
    requiredStatusCheck: env.BUILDCHAIN_REQUIRED_STATUS_CHECK,
    createAlphaPr: env.BUILDCHAIN_CREATE_ALPHA_PR === "true",
    setDefault: env.BUILDCHAIN_SET_DEFAULT_BRANCH === "true",
  });
  requireValue(
    /^[0-9a-f]{40}$/.test(plan.source.sha),
    "Release line source must be an exact commit",
  );
  writeState(env, "plan", plan);
  const outputs = {
    line: plan.line,
    dev_ref: plan.refs.dev,
    alpha_ref: plan.refs.alpha,
    release_ref: plan.refs.release,
    bootstrap_ref: plan.refs.bootstrap,
    source_sha: plan.source.sha,
    initial_version: plan.initialVersion,
  };
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  console.log(JSON.stringify(plan, null, 2));
  return plan;
}
export function summarizeLine(env) {
  const plan = readPlan(env);
  fs.appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    [
      "## Release line bootstrap dry run",
      "",
      `- line: ${plan.line}`,
      `- source: ${plan.source.ref} @ ${plan.source.sha}`,
      `- dev: ${plan.refs.dev}`,
      `- alpha: ${plan.refs.alpha}`,
      `- release: ${plan.refs.release}`,
      `- initial version: ${plan.initialVersion}`,
      `- merge queue mode: ${plan.governance.mergeQueue.mode}`,
      "",
      "Re-run with `apply=true` to create refs, protection, default branch, and alpha PR.",
      "",
    ].join("\n"),
  );
}
export function assertApply(env) {
  requireValue(
    env.BUILDCHAIN_APPLY === "true",
    "Release line effects require apply=true",
  );
}
export function writeLine(env, execute = command) {
  assertApply(env);
  const plan = readPlan(env);
  const head = execute("git", ["rev-parse", "HEAD"], { stdio: "pipe" }).trim();
  requireValue(
    head === plan.source.sha,
    "Source changed after release line planning",
  );
  const status = execute(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { stdio: "pipe" },
  );
  requireValue(!status.trim(), "Source checkout changed after planning");
  const result = writeReleaseLineBootstrapVersionState({
    major: plan.major,
    minor: plan.minor,
    sourceRef: plan.source.ref,
    initialVersion: plan.initialVersion,
  });
  requireValue(
    result.changedFiles.length > 0,
    "Release line version state produced no changes",
  );
  writeState(env, "write", result);
}
export function commitAndPushLine(env, execute = command) {
  assertApply(env);
  const plan = readPlan(env);
  const written = JSON.parse(fs.readFileSync(statePath(env, "write"), "utf8"));
  requireValue(
    written.source.sha === plan.source.sha &&
      written.initialVersion === plan.initialVersion,
    "Version state does not match the release line plan",
  );
  requireValue(
    written.changedFiles.length > 0,
    "No version state files to commit",
  );
  execute("git", ["add", "--", ...written.changedFiles]);
  execute("git", [
    "-c",
    "user.name=Keren Dong",
    "-c",
    "user.email=keren.dong@kungfu.link",
    "commit",
    "-s",
    "-m",
    `chore(release): open ${plan.line}`,
  ]);
  for (const [source, ref] of [
    ["HEAD", plan.refs.bootstrap],
    ["HEAD", plan.refs.dev],
    [plan.source.sha, plan.refs.alpha],
    [plan.source.sha, plan.refs.release],
  ]) {
    execute("git", ["push", "origin", `${source}:refs/heads/${ref}`]);
  }
}
