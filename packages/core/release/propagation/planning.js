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
} from "./store.js";

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
export function writePropagationInputs(context) {
  const input = request(context);
  const workContext = validatePropagationMode(input);
  writePropagation("graph.json", JSON.parse(input["graph-json"]), context);
  writePropagation(
    "upstream-release.json",
    JSON.parse(input["upstream-release-json"]),
    context,
  );
  if (workContext) writePropagation("work-context.json", workContext, context);
}
export function controllerIdentities(context, execute = command) {
  const { runtime } = propagationPaths(context);
  const sha = execute("git", ["-C", runtime, "rev-parse", "HEAD"], {
    stdio: "pipe",
  }).trim();
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(runtime, "dist/site/buildchain-contract.json"),
      "utf8",
    ),
  );
  return {
    "runtime-sha": sha,
    "contract-digest": contract.contractDigest,
  };
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
export function planPropagation(context) {
  const input = request(context);
  const plan = planReleasePropagation({
    graph: readPropagation("graph.json", context),
    upstreamRelease: readPropagation("upstream-release.json", context),
    sourceNode: input["source-node"] || "",
  });
  const target = selectPropagationTarget(plan, input);
  writePropagation("plan.json", plan, context);
  const pkg = target.lock.upstream.package || {},
    profile = target.executionProfile || {};
  return {
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
  };
}
export function resolvePropagationBranch(context, execute = command) {
  const input = request(context),
    { downstream } = propagationPaths(context);
  const target = selectPropagationTarget(
    readPropagation("plan.json", context),
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
  return {
    state: remoteSha ? "reused" : "created",
    base_sha: base,
    branch: target.branch,
  };
}
export function capturePropagationWork(context) {
  const input = request(context);
  const workContext = validatePropagationMode(input);
  const work = createReleasePropagationWork({
    plan: readPropagation("plan.json", context),
    target: input["downstream-target"],
    expectedDownstreamBaseSha: readPropagation("branch.json", context).base_sha,
    workContext,
  });
  writePropagation("work.json", work, context);
  return {
    lifecycle: work.state.lifecycle,
    execute: work.authority.mode === "execute",
  };
}
export function writePropagationLock(context) {
  const status = verifyReleasePropagationWork(
    readPropagation("work.json", context),
  );
  requireValue(
    status.work.authority.mode === "execute" &&
      status.currentStage === "materialize",
    "Propagation Work does not authorize materialization",
  );
  const input = request(context);
  const result = writeReleasePropagationLock({
    plan: readPropagation("plan.json", context),
    target: input["downstream-target"],
    cwd: propagationPaths(context).downstream,
    output: input["lock-path"] || "",
  });
  writePropagation("write-lock.json", result, context);
  return {
    path: result.path,
    lock_sha: result.lockSha256,
    status: result.status,
    changed: result.changed,
    propagation_key: result.propagationKey,
    branch: result.branch,
  };
}
