import fs from "node:fs";
import path from "node:path";
import { getOctokit } from "@actions/github";
import {
  collectGovernanceEvidence,
  finalizeGovernanceEvidence,
} from "./transactions.js";

export function collectGovernanceEvidenceAction(core, env) {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const scoped = ["pull_request", "merge_group"].includes(
    env.GITHUB_EVENT_NAME,
  );
  const { result, summary } = collectGovernanceEvidence({
    organization: env.GITHUB_REPOSITORY_OWNER,
    repository: scoped ? env.GITHUB_REPOSITORY : "",
    targetRef:
      event.pull_request?.base?.ref || event.merge_group?.base_ref || "",
    runtimeSha: env.BUILDCHAIN_RUNTIME_SHA,
    workspace: env.GITHUB_WORKSPACE,
    token: core.getInput("token", { required: true }),
  });
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  core.setOutput("non-qualifying", result.inventory.nonQualifyingCount);
  core.setOutput("audit-root", result.auditRoot);
}

export async function finalizeGovernanceEvidenceAction(core, env) {
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const result = await finalizeGovernanceEvidence(
    {
      receipt: JSON.parse(
        fs.readFileSync(
          path.join(env.GITHUB_WORKSPACE, "github-governance-audit.json"),
          "utf8",
        ),
      ),
      event: {
        name: env.GITHUB_EVENT_NAME,
        payload: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
      },
      credential: JSON.parse(
        core.getInput("credential-json", { required: true }),
      ),
      context: {
        repo: { owner, repo },
        runId: env.GITHUB_RUN_ID,
        serverUrl: env.GITHUB_SERVER_URL,
      },
    },
    getOctokit(core.getInput("token", { required: true })),
  );
  if (result.warning) core.warning(result.warning);
}
