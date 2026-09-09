import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import * as override from "../runtime-override-authorization.js";

export function admitPromotionConsumer(env = process.env, run = command) {
  const request = JSON.parse(env.BUILDCHAIN_PROMOTION_REQUEST_JSON);
  const selection = JSON.parse(env.BUILDCHAIN_PROMOTION_SELECTION_JSON);
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const runtime = path.join(workspace, ".buildchain/policy-runtime");
  const head = run("git", ["-C", runtime, "rev-parse", "HEAD"], {
    stdio: "pipe",
  }).trim();
  if (head !== selection["router-sha"])
    throw Error("Promotion policy runtime checkout moved");
  const sourceSha = request["target-sha"] || env.GITHUB_SHA;
  const sourceHead = run(
    "git",
    ["-C", path.join(workspace, ".buildchain/consumer"), "rev-parse", "HEAD"],
    { stdio: "pipe" },
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceSha || "") || sourceHead !== sourceSha)
    throw Error("Promotion consumer source checkout moved");
  const invocationHead = run(
    "git",
    [
      "-C",
      path.join(workspace, ".buildchain/invocation-source"),
      "rev-parse",
      "HEAD",
    ],
    { stdio: "pipe" },
  ).trim();
  if (
    !/^[0-9a-f]{40}$/.test(env.GITHUB_WORKFLOW_SHA || "") ||
    invocationHead !== env.GITHUB_WORKFLOW_SHA
  )
    throw Error("Promotion caller workflow definition checkout moved");
  return run(
    process.execPath,
    [
      path.join(runtime, "packages/core/consumer/commands/consumer-policy.mjs"),
      "scan",
      "--source-sha",
      sourceSha,
    ],
    {
      env: {
        ...env,
        BUILDCHAIN_CONSUMER_ROOT: path.join(workspace, ".buildchain/consumer"),
        BUILDCHAIN_INVOCATION_SOURCE_ROOT: path.join(
          workspace,
          ".buildchain/invocation-source",
        ),
        BUILDCHAIN_INVOCATION_SOURCE_PATH: env.GITHUB_WORKFLOW_REF,
        BUILDCHAIN_DEFINITION_REPOSITORY: selection.repository,
        BUILDCHAIN_DEFINITION_SHA: env.GITHUB_WORKFLOW_SHA,
        BUILDCHAIN_EXPECTED_INVOCATION_CHANNEL: selection.channel,
        BUILDCHAIN_INVOKED_WORKFLOW:
          ".github/workflows/public-release-promote.yml",
        BUILDCHAIN_WORKFLOW_SHA: selection["router-sha"],
        BUILDCHAIN_RUNTIME_SHA: selection["router-sha"],
        BUILDCHAIN_STABLE_CONTRACT_LOCK_PATH:
          request["buildchain-stable-contract-lock-path"],
        BUILDCHAIN_ALPHA_CONTRACT_LOCK_PATH:
          request["buildchain-alpha-contract-lock-path"],
        BUILDCHAIN_V4_POLICY_RECEIPT_PATH:
          ".buildchain/evidence/consumer-policy-receipt.json",
      },
    },
  );
}
export async function authorizePromotionSelection({
  github,
  context,
  core,
  env = process.env,
}) {
  const request = JSON.parse(env.BUILDCHAIN_PROMOTION_REQUEST_JSON);
  const selection = JSON.parse(env.BUILDCHAIN_PROMOTION_SELECTION_JSON);
  if (selection["override-used"] !== "true")
    throw Error("Runtime authorization requires an actual override");
  const root = path.join(env.GITHUB_WORKSPACE, ".buildchain/consumer");
  const mode = request["resume-candidate-run-id"] ? "resume" : "dispatch";
  const result = await override.authorizePromotionRuntimeOverride({
    github,
    context,
    request: {
      consumerRoot: root,
      runtimeModulePath: path.join(
        env.GITHUB_WORKSPACE,
        ".buildchain/policy-runtime/packages/core/consumer/runtime-ref-resume-authority.js",
      ),
      runtimeRepository: request["buildchain-repository"],
      consumerPolicyReceiptPath: path.join(
        root,
        ".buildchain/evidence/consumer-policy-receipt.json",
      ),
      consumerPolicyReceiptRoot: env.BUILDCHAIN_CONSUMER_POLICY_ROOT,
      sourceSha: request["target-sha"] || context.sha,
      requestedRef: selection["runtime-ref"],
      resolvedRuntimeSha: selection["runtime-sha"],
      reason: `trusted ${mode} runtime override ${selection["runtime-ref"]} for source ${request["target-sha"] || context.sha}`,
      mode,
      outputPath: path.join(
        root,
        ".buildchain/evidence/runtime-authorization.json",
      ),
    },
  });
  core.setOutput(
    "runtime-authorization-json",
    JSON.stringify({
      receipt: result.receipt,
      receiptRoot: result.receiptRoot,
    }),
  );
  core.setOutput("runtime-authorization-root", result.receiptRoot);
  return result;
}
