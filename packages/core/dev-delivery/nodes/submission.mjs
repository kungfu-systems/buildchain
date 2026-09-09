import { runtimeCommand } from "./io.mjs";
import { sourceProofPaths } from "./source-paths.mjs";
import {
  environmentArguments,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";
import { pathToFileURL } from "node:url";

export function submissionArguments(env) {
  const args = [
    "submit",
    ...environmentArguments(
      {
        repository: "GITHUB_REPOSITORY",
        branch: "TARGET_BRANCH",
        "pull-request": "EXPECTED_PR",
        "source-head": "EXPECTED_HEAD",
        "source-root": "SOURCE_ROOT",
        "source-identity-root": "SOURCE_IDENTITY_ROOT",
        "source-patch-root": "SOURCE_PATCH_ROOT",
        "source-proof-root": "SOURCE_PROOF_ROOT",
        "plan-root": "PLAN_ROOT",
        "closure-root": "CLOSURE_ROOT",
        "dependency-root": "DEPENDENCY_ROOT",
        "toolchain-root": "TOOLCHAIN_ROOT",
        "affected-paths-json": "AFFECTED_PATHS",
        "shard-evidence-roots-json": "SHARD_ROOTS",
        "delivery-class": "DELIVERY_CLASS",
        priority: "DELIVERY_PRIORITY",
      },
      env,
    ),
    "--output",
    ".buildchain/dev-delivery/submission.json",
  ];
  if (env.ENVIRONMENT_ROOT)
    args.push(
      "--environment-root",
      env.ENVIRONMENT_ROOT,
      "--native-command",
      env.NATIVE_COMMAND || "",
    );
  else
    requireValue(
      !env.NATIVE_COMMAND,
      "Native command requires an exact environment root",
    );
  for (const [flag, key] of Object.entries({
    "native-command-root": "NATIVE_COMMAND_ROOT",
    "release-blocker-priority-json": "RELEASE_BLOCKER_PRIORITY",
  })) {
    if (env[key]) args.push(`--${flag}`, env[key]);
  }
  if (Number(env.SOURCE_WORKFLOW_RUN_ID) > 0)
    args.push("--source-workflow-run-id", env.SOURCE_WORKFLOW_RUN_ID);
  if (env.WARRANT_MODE === "required") args.push("--execute");
  return args;
}
export function submitCandidate(env) {
  env = { ...env, AFFECTED_PATHS: sourceProofPaths(env) };
  return runtimeCommand("dev-delivery-warrant", submissionArguments(env));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({ submit: submitCandidate });
