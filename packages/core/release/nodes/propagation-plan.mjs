import { exactRemoteBranch } from "../../providers/git-ref-readback.mjs";
import fs from "node:fs";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";
import {
  planReleasePropagation,
  createReleasePropagationWork,
  writeReleasePropagationLock,
  verifyReleasePropagationWork,
} from "../release-propagation.js";
import {
  propagationPaths,
  request,
  readPropagation,
  writePropagation,
  propagationOutputs,
} from "./propagation-io.mjs";

export function validatePropagationMode(input) {
  const mode = input["agent-work-mode"];
  requireValue(
    ["capture-only", "execute"].includes(mode),
    "agent-work-mode must be capture-only or execute",
  );
  const context = input["agent-work-context-json"]
    ? JSON.parse(input["agent-work-context-json"])
    : undefined;
  requireValue(
    mode !== "execute" || Boolean(context),
    "Executing propagation requires an exact authorized Work context",
  );
  requireValue(
    !context || context.authority?.mode === mode,
    "Propagation request and Work authority modes disagree",
  );
  return context;
}
export function writePropagationInputs(env) {
  const input = request(env);
  const context = validatePropagationMode(input);
  writePropagation("graph.json", JSON.parse(input["graph-json"]), env);
  writePropagation(
    "upstream-release.json",
    JSON.parse(input["upstream-release-json"]),
    env,
  );
  if (context) writePropagation("work-context.json", context, env);
}
export function controllerIdentities(env, execute = command) {
  const { runtime } = propagationPaths(env);
  const sha = execute("git", ["-C", runtime, "rev-parse", "HEAD"], {
    stdio: "pipe",
  }).trim();
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(runtime, "dist/site/buildchain-contract.json"),
      "utf8",
    ),
  );
  propagationOutputs({
    "runtime-sha": sha,
    "contract-digest": contract.contractDigest,
  });
}
export function selectPropagationTarget(plan, input) {
  const targets = plan.targets.filter(
    (entry) =>
      entry.target === input["downstream-target"] ||
      entry.repository === input["downstream-target"],
  );
  requireValue(
    targets.length === 1,
    "Propagation target must resolve exactly once",
  );
  const target = targets[0];
  const expected = {
    repository: target.repository,
    baseRef: target.baseRef,
    branch: target.branch,
    lockPath: target.lockPath,
  };
  const actual = {
    repository: input["downstream-repository"],
    baseRef: input["downstream-base-ref"],
    branch: input["downstream-branch"] || target.branch,
    lockPath: input["lock-path"] || target.lockPath,
  };
  requireValue(
    JSON.stringify(actual) === JSON.stringify(expected),
    "Downstream caller coordinates disagree with the exact propagation graph",
  );
  return target;
}
export function planPropagation(env) {
  const input = request(env);
  const plan = planReleasePropagation({
    graph: readPropagation("graph.json", env),
    upstreamRelease: readPropagation("upstream-release.json", env),
    sourceNode: input["source-node"] || "",
  });
  const target = selectPropagationTarget(plan, input);
  writePropagation("plan.json", plan, env);
  const pkg = target.lock.upstream.package || {},
    profile = target.executionProfile || {};
  propagationOutputs({
    target: target.target,
    repository: target.repository,
    channel: target.channel,
    lock_path: target.lockPath,
    lock_sha: target.lock.lockSha256,
    package_name: pkg.name || "",
    package_version: pkg.version || "",
    propagation_key: target.propagationKey,
    branch: target.branch,
    update_command: profile.updateCommand || "",
    prepare_command: profile.prepareCommand || "",
    verify_command: profile.verifyCommand || "",
  });
}
export function resolvePropagationBranch(env, execute = command) {
  const input = request(env),
    { downstream } = propagationPaths(env);
  const target = selectPropagationTarget(
    readPropagation("plan.json", env),
    input,
  );
  const base = execute("git", ["rev-parse", "HEAD"], {
    cwd: downstream,
    stdio: "pipe",
  }).trim();
  const remoteSha = exactRemoteBranch(target.branch, execute, downstream);
  if (remoteSha) {
    execute(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        `refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`,
      ],
      { cwd: downstream },
    );
    execute(
      "git",
      ["checkout", "-B", target.branch, `refs/remotes/origin/${target.branch}`],
      { cwd: downstream },
    );
  } else
    execute("git", ["checkout", "-B", target.branch, base], {
      cwd: downstream,
    });
  propagationOutputs({
    state: remoteSha ? "reused" : "created",
    base_sha: base,
    branch: target.branch,
  });
}
export function capturePropagationWork(env) {
  const input = request(env);
  const context = validatePropagationMode(input);
  const work = createReleasePropagationWork({
    plan: readPropagation("plan.json", env),
    target: input["downstream-target"],
    expectedDownstreamBaseSha: JSON.parse(
      env.BUILDCHAIN_PROPAGATION_BRANCH_JSON,
    ).base_sha,
    workContext: context,
  });
  writePropagation("work.json", work, env);
  propagationOutputs({
    lifecycle: work.state.lifecycle,
    execute: work.authority.mode === "execute",
  });
}
export function writePropagationLock(env) {
  const status = verifyReleasePropagationWork(
    readPropagation("work.json", env),
  );
  requireValue(
    status.work.authority.mode === "execute" &&
      status.currentStage === "materialize",
    "Propagation Work does not authorize materialization",
  );
  const input = request(env);
  const result = writeReleasePropagationLock({
    plan: readPropagation("plan.json", env),
    target: input["downstream-target"],
    cwd: propagationPaths(env).downstream,
    output: input["lock-path"] || "",
  });
  writePropagation("write-lock.json", result, env);
  propagationOutputs({
    path: result.path,
    lock_sha: result.lockSha256,
    status: result.status,
    changed: result.changed,
    propagation_key: result.propagationKey,
    branch: result.branch,
  });
}
