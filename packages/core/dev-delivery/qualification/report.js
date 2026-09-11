export function renderDevQualificationSummary(result) {
  return [
    "## Buildchain Dev qualification patrol",
    "",
    `State: \`${result.state}\``,
    `Action: \`${result.action}\` (${result.reason})`,
    `Source: \`${result.sourceBranch}@${result.sourceSha}\``,
    `Active run: ${result.activeRun?.url || "none"}`,
    `Pending SHA: \`${result.pendingSha || "none"}\``,
    `Mutation authorized: \`${result.mutationAuthorized}\``,
    "",
  ].join("\n");
}
export function devQualificationOutputs(result, outputPath) {
  return {
    "result-path": outputPath,
    state: result.state,
    action: result.action,
    reason: result.reason,
    "source-sha": result.sourceSha,
    "pending-sha": result.pendingSha || "",
    "active-run-id": result.activeRun?.id || "",
    "decision-root": result.decisionRoot,
  };
}
