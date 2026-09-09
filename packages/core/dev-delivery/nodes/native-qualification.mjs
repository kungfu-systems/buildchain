import fs from "node:fs";
import { outputs, runtimeCommand } from "./io.mjs";
import { sourceProofPaths } from "./source-paths.mjs";
import {
  environmentArguments,
  requireValue,
} from "../../runtime/action-process.mjs";

export function twoPhaseArguments(env, phase) {
  requireValue(
    ["execute", "finalize"].includes(phase),
    "Unknown native execution phase",
  );
  const native = phase === "execute";
  const args = environmentArguments(
    {
      repository: "GITHUB_REPOSITORY",
      branch: "TARGET_BRANCH",
      "pull-request": "EXPECTED_PR",
      "expected-head": "EXPECTED_HEAD",
      "source-identity-root": "SOURCE_IDENTITY_ROOT",
      "source-patch-root": "SOURCE_PATCH_ROOT",
      "plan-root": "PLAN_ROOT",
      "closure-root": "CLOSURE_ROOT",
      "dependency-root": "DEPENDENCY_ROOT",
      "toolchain-root": "TOOLCHAIN_ROOT",
      "environment-root": "ENVIRONMENT_ROOT",
      "affected-paths-json": "AFFECTED_PATHS",
      "shard-evidence-roots-json": "SHARD_ROOTS",
      "native-command": "NATIVE_COMMAND",
      "lease-seconds": "LEASE_SECONDS",
      "heartbeat-seconds": "HEARTBEAT_SECONDS",
    },
    env,
  );
  args.push(
    "--warrant-result",
    ".buildchain/dev-delivery/warrant.json",
    "--candidate-directory",
    native ? ".buildchain/candidate" : ".buildchain/runtime",
    "--evidence-directory",
    native ? ".buildchain/dev-delivery" : ".buildchain/finalizer-evidence",
    native ? "--native-only" : "--finalize-only",
  );
  if (native && env.NATIVE_PROOF_PATH)
    args.push("--native-proof", env.NATIVE_PROOF_PATH);
  if (!native && fs.existsSync(".buildchain/native-transfer/native-proof.json"))
    args.push(
      "--native-proof",
      ".buildchain/native-transfer/native-proof.json",
    );
  return args;
}
export function verifyTwoPhaseReadback(result, env, phase) {
  const native = phase === "execute";
  requireValue(
    result.ok === true &&
      result.outcome === (native ? "native-proof-ready" : "qualified-warrant"),
    "Native qualification did not reach the expected outcome",
  );
  requireValue(
    result.qualifiedWarrant?.phase === (native ? "provisional" : "qualified") &&
      result.qualifiedWarrant.pullRequestNumber === Number(env.EXPECTED_PR) &&
      result.qualifiedWarrant.sourceHead === env.EXPECTED_HEAD,
    "Native qualification Warrant identity or phase drift",
  );
  for (const key of [
    "nativeProofRoot",
    "nativeReuseDecisionRoot",
    ...(!native ? ["qualificationReceiptRoot"] : []),
  ])
    requireValue(
      /^sha256:[0-9a-f]{64}$/u.test(result[key] || ""),
      `Native qualification ${key} is missing`,
    );
  return {
    "native-proof-root": result.nativeProofRoot,
    "decision-root": result.nativeReuseDecisionRoot,
    ...(!native
      ? { "qualification-receipt-root": result.qualificationReceiptRoot }
      : {}),
  };
}
export function qualifyNative(env, phase) {
  env = { ...env, AFFECTED_PATHS: sourceProofPaths(env) };
  runtimeCommand("dev-delivery-two-phase", twoPhaseArguments(env, phase));
  const file =
    phase === "execute"
      ? ".buildchain/dev-delivery/two-phase-native-result.json"
      : ".buildchain/finalizer-evidence/two-phase-result.json";
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  const readback = verifyTwoPhaseReadback(result, env, phase);
  if (phase === "finalize")
    fs.copyFileSync(
      ".buildchain/finalizer-evidence/qualified-warrant.json",
      ".buildchain/dev-delivery/warrant.json",
    );
  outputs(readback);
}
