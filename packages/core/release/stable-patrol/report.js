export function renderStablePatrolSummary(result) {
  const selected = result.selection.selected
    ? result.selection.candidate.version
    : "none";
  return [
    "## Buildchain stable candidate patrol",
    "",
    `Repository: \`${result.repository}\``,
    `Target: \`${result.targetBranch}\``,
    `Ledger: \`${result.ledgerRef}\``,
    `Selected: \`${selected}\` (${result.selection.reason})`,
    `Dry run: \`${result.dryRun}\``,
    "",
    `Candidates: ${JSON.stringify(result.summary)}`,
    "",
  ].join("\n");
}

export function stablePatrolOutputs(result, outputPath) {
  return {
    "result-path": outputPath,
    selected: String(result.selection.selected),
    "selected-version": result.selection.candidate?.version || "",
    "selected-sha": result.selection.candidate?.sha || "",
    "stable-version": result.selection.candidate?.stableVersion || "",
    "promotion-pr": result.promotion?.pullRequest?.html_url || "",
  };
}
