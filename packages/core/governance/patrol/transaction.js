import fs from "node:fs";
import path from "node:path";
import { normalizePatrolOptions } from "./options.js";
import { runBuildchainPatrol } from "./controller.js";
import { renderPatrolMarkdownSummary } from "./report.js";
export async function reconcileRepositoryPatrol(
  { options: input, summaryPath },
  client,
) {
  const options = normalizePatrolOptions(input);
  if (!client && options.capabilities.includes("merge-ready-dev-prs"))
    throw new Error("Repository patrol requires an explicit provider client");
  const result = await runBuildchainPatrol(options, client);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, JSON.stringify(result, null, 2) + "\n");
  const summary = renderPatrolMarkdownSummary(result);
  if (summaryPath) fs.appendFileSync(summaryPath, summary);
  else console.log(summary);
  return {
    result,
    outputs: {
      "result-path": options.outputPath,
      "evaluated-count": result.summary.evaluatedCount,
      "action-count": result.summary.actionCount,
      "skipped-count": result.summary.skippedCount,
      "planned-count": result.summary.plannedCount,
      "branch-artifact": result.targetBranch.replaceAll("/", "-"),
    },
  };
}
