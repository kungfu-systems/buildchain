import fs from "node:fs";
import path from "node:path";
import { collectGithubGovernanceAudit } from "./collection.js";
import { reportGovernanceIncident } from "./incident.mjs";

export function collectGovernanceEvidence(
  {
    organization,
    repository,
    targetRef,
    runtimeSha,
    workspace,
    token,
  },
  collect = collectGithubGovernanceAudit,
) {
  const result = collect({
    organization,
    repository,
    targetRef,
    verifierSourceRevision: runtimeSha,
    token,
  });
  const { qualifyingCount, nonQualifyingCount } = result.inventory;
  if (
    ![qualifyingCount, nonQualifyingCount].every(
      (value) => Number.isInteger(value) && value >= 0,
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(result.auditRoot)
  )
    throw new Error("Invalid governance inventory receipt");
  fs.writeFileSync(
    path.join(workspace, "github-governance-audit.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return {
    result,
    summary: [
      "## GitHub governance authority",
      "",
      `- qualifying: ${qualifyingCount}`,
      `- non-qualifying: ${nonQualifyingCount}`,
      `- audit root: \`${result.auditRoot}\``,
      "",
    ].join("\n"),
  };
}

export async function finalizeGovernanceEvidence(
  { receipt, event, credential, context },
  github,
) {
  const nonQualifying = receipt.inventory.nonQualifyingCount;
  if (!nonQualifying) return { qualified: true };
  if (["schedule", "workflow_dispatch"].includes(event.name))
    await reportGovernanceIncident({
      github,
      context,
      auditRoot: receipt.auditRoot,
      nonQualifying,
    });
  const limitedFork =
    event.name === "pull_request" &&
    event.payload.pull_request?.head?.repo?.fork &&
    credential.source === "workflow";
  if (limitedFork)
    return {
      qualified: false,
      warning:
        "Fork PR governance is credential-limited; the sanitized non-qualifying receipt is retained and protected independent review remains authoritative.",
    };
  throw new Error("Managed-zone GitHub governance is non-qualifying.");
}
