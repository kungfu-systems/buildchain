import fs from "node:fs";
import * as github from "@actions/github";
import { lookupSourceProof } from "./proof-lookup.js";
import { sourceProofRequest, evaluateSourceProof } from "./proof.js";
const json = (core, name) =>
  JSON.parse(core.getInput(name, { required: true }));

export async function lookupSourceProofAction(core, env) {
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const result = await lookupSourceProof({
    github: github.getOctokit(core.getInput("token", { required: true })),
    repository: { owner, repo },
    mergeGroupHeadRef: event.merge_group?.head_ref,
    callerWorkflowRef: env.GITHUB_WORKFLOW_REF,
  });
  for (const [key, value] of Object.entries(result)) core.setOutput(key, value);
}
export function evaluateSourceProofAction(core, env) {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const candidate = json(core, "candidate-json"),
    identities = json(core, "identities-json");
  const input = sourceProofRequest({
    workspace: env.GITHUB_WORKSPACE,
    request: json(core, "request-json"),
    identities,
    runtimeRef: core.getInput("runtime-ref", { required: true }),
    repository: env.GITHUB_REPOSITORY,
    protectedBase: event.merge_group?.base_ref,
    sourceHead: candidate["source-head"],
    sourceWorkflowRunId: candidate["run-id"],
  });
  const decision = evaluateSourceProof(
    {
      ...input,
      currentBase: event.merge_group?.base_sha,
      mergeGroupHead: identities["source-sha"],
      verifiedAt: new Date().toISOString(),
    },
    {
      sourceRef: env.GITHUB_REF,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      platformId: env.RUNNER_OS || process.platform,
      platformName: env.RUNNER_NAME || env.RUNNER_OS || process.platform,
      runnerOs: env.RUNNER_OS || process.platform,
      runnerArch: env.RUNNER_ARCH || process.arch,
    },
  );
  for (const [key, value] of Object.entries({
    reuse: String(decision.reusable),
    "proof-root": decision.sourceProofRoot || "",
    reason: decision.reason,
    "decision-root": decision.decisionRoot,
  }))
    core.setOutput(key, value);
}
