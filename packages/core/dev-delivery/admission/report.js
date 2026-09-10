import { skip } from "./readiness.js";
export function renderMarkdownSummary(result) {
  const lines = [
    "## Buildchain dev PR auto-merge",
    "",
    `Repository: \`${result.repository}\``,
    `Target branch: \`${result.targetBranch}\``,
    `Landing mode: \`${result.landingMode}\``,
    `Execution: \`${result.dryRun ? "dry-run" : "apply"}\``,
    `Evaluated PRs: ${result.evaluated.length}`,
    `Actions ${result.dryRun ? "planned" : "taken"}: ${result.actions.length}`,
    "",
    "| PR | Action | Reason | Head |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of result.evaluated) {
    lines.push(
      `| #${entry.number} | ${entry.action} | ${entry.reason} | \`${entry.headRef || ""}\` |`,
    );
  }
  if (result.evaluated.length === 0)
    lines.push("| - | skip | no open pull requests | - |");
  if (!result.dryRun && result.finalBaseSha) {
    lines.push("", `Final target branch SHA: \`${result.finalBaseSha}\``);
  }
  return `${lines.join("\n")}\n`;
}
