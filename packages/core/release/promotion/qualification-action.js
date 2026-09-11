import fs from "node:fs";
import path from "node:path";
import { getOctokit } from "@actions/github";
import { command } from "../../runtime/action-process.mjs";
import { installationRoot } from "../../runtime/installation-root.js";
import { verifyPromotionInvocation } from "../promotion-request.js";
import { recoveryFailure } from "../release-candidate-recovery.js";
import { productPublicationReader } from "../../providers/github/product-publication.js";
import { qualifyPromotion } from "./qualification.js";
export async function qualifyPromotionAction(core, env) {
  const workflowSha = core.getInput("workflow-sha", { required: true }),
    request = verifyPromotionInvocation(
      core.getInput("request-json", { required: true }),
      workflowSha,
    );
  const runtimeRoot = installationRoot(import.meta.url),
    workspace = path.resolve(env.GITHUB_WORKSPACE),
    runtimeSha = request["promotion-runtime-sha"];


  const tree = command("git", ["-C", runtimeRoot, "rev-parse", "HEAD^{tree}"], {
    stdio: "pipe",
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(tree))
    throw new Error("Promotion runtime tree must be exact");
  for (const [key, value] of Object.entries({
    "runtime-sha": runtimeSha,
    "runtime-tree": tree,
    "publisher-sha": workflowSha,
  }))
    core.setOutput(key, value);
  const token = core.getInput("token", { required: true });
  try {
    const result = await qualifyPromotion(
      {
        request,
        repository: env.GITHUB_REPOSITORY,
        sourceSha: env.GITHUB_SHA,
        sourceRef: env.GITHUB_REF,
        workspace,
        runtimeSha,
        runtimeRoot,
        token,
        apiUrl: env.GITHUB_API_URL,
        recoveryRunId: env.GITHUB_RUN_ID,
        recoveryRunAttempt: env.GITHUB_RUN_ATTEMPT,
      },
      productPublicationReader(getOctokit(token), env.GITHUB_REPOSITORY),
    );
    for (const [key, value] of Object.entries(result))
      core.setOutput(key, value);
  } catch (error) {
    if (request["resume-candidate-run-id"]) {
      const failure = recoveryFailure(error);
      core.error(
        `Candidate recovery rejected [${failure.code}]: ${failure.reason}; next: ${failure.nextAction}`,
      );
    }
    throw error;
  }
}
