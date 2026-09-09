import { outputs, readEvidence, runtimeCommand, writeEvidence } from "./io.mjs";
import {
  command,
  environmentArguments,
  requireValue,
} from "../../runtime/action-process.mjs";

export function validateTerminalIntent(env) {
  requireValue(
    ["merged", "terminal-failure", "dequeued", "cancelled"].includes(
      env.OUTCOME,
    ),
    "unsupported terminal Warrant outcome",
  );
  requireValue(
    /^dev\/v\d+\/v\d+\.\d+$/u.test(env.TARGET_BRANCH || ""),
    "target-branch must be a semver dev branch",
  );
  requireValue(
    /^[0-9a-f]{40}$/u.test(env.EXPECTED_HEAD || ""),
    "expected-head-sha must be an exact lowercase Git SHA",
  );
}
export function settlementMode(observation, env) {
  const warrant = observation.activeWarrant;
  if (!warrant) return "inactive";
  const candidate = observation.activeCandidate;
  requireValue(
    warrant.pullRequestNumber === Number(env.EXPECTED_PR) &&
      warrant.sourceHead === env.EXPECTED_HEAD &&
      candidate?.pullRequestNumber === Number(env.EXPECTED_PR) &&
      candidate.sourceHead === env.EXPECTED_HEAD &&
      candidate.candidateId === warrant.candidateId,
    "Active terminal Warrant does not bind the exact requested candidate",
  );
  return "active";
}
export function resolveSettlement(env) {
  outputs({
    mode: settlementMode(readEvidence("observation.json").observation, env),
  });
}
export function sealTerminalEvidence(env) {
  let root = env.TERMINAL_EVIDENCE_ROOT;
  if (env.OUTCOME === "merged") {
    const proofRoot =
      readEvidence("observation.json").observation.activeCandidate
        .sourceProofRoot;
    requireValue(
      /^sha256:[0-9a-f]{64}$/u.test(proofRoot || ""),
      "Active source proof root is missing",
    );
    runtimeCommand("dev-delivery-proof", [
      "integration",
      ...environmentArguments(
        {
          repository: "GITHUB_REPOSITORY",
          branch: "TARGET_BRANCH",
          "current-base": "CURRENT_BASE",
          "replay-tree": "REPLAY_TREE",
          "merge-group-head": "MERGE_GROUP_HEAD",
          "merge-group-tree": "MERGE_GROUP_TREE",
          "required-context-roots-json": "CONTEXT_ROOTS",
        },
        env,
      ),
      "--source-proof-root",
      proofRoot,
      "--warrant-result",
      ".buildchain/dev-delivery/observation.json",
      "--verified-at",
      new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
      "--output",
      ".buildchain/dev-delivery/integration-proof.json",
    ]);
    root = readEvidence("integration-proof.json").proofRoot;
    outputs({ "integration-proof-root": root });
  }
  requireValue(
    /^sha256:[0-9a-f]{64}$/u.test(root || ""),
    "terminal closeout requires an exact evidence root",
  );
  outputs({ "evidence-root": root });
}
export function settleTerminal(env) {
  const args = [
    "settle",
    ...environmentArguments(
      {
        repository: "GITHUB_REPOSITORY",
        branch: "TARGET_BRANCH",
        "pull-request": "EXPECTED_PR",
        "expected-source-head": "EXPECTED_HEAD",
        outcome: "OUTCOME",
        reason: "REASON",
      },
      env,
    ),
    "--execute",
    "--output",
    ".buildchain/dev-delivery/close.json",
  ];
  if (env.SETTLEMENT_MODE === "active") {
    const observation = readEvidence("observation.json").observation;
    requireValue(
      settlementMode(observation, env) === "active",
      "Active Warrant disappeared before settlement",
    );
    args.push(
      "--fencing-token",
      observation.activeWarrant.fencingToken,
      "--lease-generation",
      String(observation.activeWarrant.generation),
    );
  }
  if (env.EVIDENCE_ROOT) args.push("--evidence-root", env.EVIDENCE_ROOT);
  runtimeCommand("dev-delivery-warrant", args);
  const result = readEvidence("close.json");
  outputs({
    "close-receipt-root": result.receiptRoot,
    "final-state-root": result.after.stateRoot,
    "successor-wake-json": JSON.stringify(result.receipt.successorWake ?? null),
  });
}
export function wakeSuccessor(env) {
  writeEvidence("successor-dispatch.json", {
    event_type: "buildchain-dev-delivery-wake",
    client_payload: { candidate: JSON.parse(env.SUCCESSOR_WAKE) },
  });
  command("gh", [
    "api",
    "--method",
    "POST",
    `repos/${env.GITHUB_REPOSITORY}/dispatches`,
    "--input",
    ".buildchain/dev-delivery/successor-dispatch.json",
  ]);
}
