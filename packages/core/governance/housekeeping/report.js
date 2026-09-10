function decisionFor(entry) {
  if (entry.kind === "branch") return entry.decision;
  return entry.actions.length > 0 ? entry.actions.join(",") : "report-only";
}

export function renderHousekeeperWorkflowReport(
  plan,
  receipt,
  { mode, scope = "all" } = {},
) {
  const lines = [
    "## Engineering Housekeeper",
    "",
    `Mode: \`${mode || "report"}\``,
    `Scope: \`${scope}\``,
    `Repository: \`${plan.repository}\``,
    `Primary mainline: \`${plan.target.name}@${plan.target.headOid}\``,
    `Observed at: \`${plan.observedAt}\``,
    `Plan root: \`${plan.planRoot}\``,
    `Receipt root: \`${receipt.receiptRoot}\``,
    "",
    "### Decisions",
    "",
    "| Subject | Observed ref | Decision | Reason codes |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of plan.inventory) {
    const subject =
      entry.kind === "branch" ? entry.name : `PR #${entry.number}`;
    lines.push(
      `| \`${subject}\` | \`${entry.headOid}\` | ${decisionFor(entry)} | \`${entry.reasonCodes.join(",")}\` |`,
    );
  }
  if (plan.inventory.length === 0)
    lines.push("| - | - | retain | `inventory.empty` |");
  lines.push(
    "",
    "### Outcomes",
    "",
    "| Action | Outcome | Details |",
    "| --- | --- | --- |",
  );
  for (const outcome of receipt.outcomes) {
    const details =
      outcome.reasonCodes?.join(",") || outcome.providerError?.operation || "-";
    lines.push(
      `| \`${outcome.action}\` | ${outcome.status} | \`${details}\` |`,
    );
  }
  if (receipt.outcomes.length === 0)
    lines.push("| - | no-op | `no-actions-in-scope` |");
  return `${lines.join("\n")}\n`;
}
