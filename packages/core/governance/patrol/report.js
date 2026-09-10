export function renderPatrolMarkdownSummary(result) {
  const lines = [
    "## Buildchain patrol",
    "",
    `Repository: \`${result.repository}\``,
    `Target branch: \`${result.targetBranch}\``,
    `Cadence: \`${result.cadence}\``,
    `Mode: \`${result.mode}\``,
    `Dry run: \`${result.dryRun ? "true" : "false"}\``,
    `Capabilities: \`${result.capabilities.join(",") || "none"}\``,
    "",
    "| Area | Count |",
    "| --- | ---: |",
    `| Evaluated PRs | ${result.summary.evaluatedCount} |`,
    `| Actions ${result.dryRun ? "planned" : "taken"} | ${result.summary.actionCount} |`,
    `| Skipped PRs | ${result.summary.skippedCount} |`,
    `| Planned future checks | ${result.summary.plannedCount} |`,
  ];

  for (const action of result.actions) {
    if (action.capability !== "merge-ready-dev-prs") continue;
    lines.push(
      "",
      "### Ready dev PRs",
      "",
      "| PR | Action | Reason | Head |",
      "| --- | --- | --- | --- |",
    );
    const evaluated = action.result.evaluated || [];
    for (const entry of evaluated) {
      lines.push(
        `| #${entry.number} | ${entry.action} | ${entry.reason} | \`${entry.headRef || ""}\` |`,
      );
    }
    if (evaluated.length === 0)
      lines.push("| - | skip | no open pull requests | - |");
  }

  if (result.planned.length > 0) {
    lines.push(
      "",
      "### Planned checks",
      "",
      "| Capability | Reason |",
      "| --- | --- |",
    );
    for (const entry of result.planned) {
      lines.push(`| \`${entry.capability}\` | ${entry.reason} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}
