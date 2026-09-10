import { CANDIDATE_BODY_HEADING } from "./values.js";
import { candidateStateMarker } from "./state.js";
export function pullRequestBody({
  options,
  observedSourceHeadSha,
  sourceSha,
  skippedNewerCommitCount,
  targetSha,
  decision,
  state,
}) {
  return [
    ...(options.pullRequestBodyPrefix
      ? [options.pullRequestBodyPrefix, ""]
      : []),
    CANDIDATE_BODY_HEADING,
    "",
    `- Source branch: \`${options.sourceBranch}\``,
    `- Observed source HEAD: \`${observedSourceHeadSha}\``,
    `- Source SHA: \`${sourceSha}\``,
    `- Skipped newer unqualified commits: \`${skippedNewerCommitCount}\``,
    `- Target branch/head: \`${options.targetBranch}\` / \`${targetSha}\``,
    `- Decision root: \`${decision.decisionRoot}\``,
    ...decision.workflowEvidence.map(
      (row) =>
        `- ${row.workflowName}: [run ${row.runId} attempt ${row.runAttempt}](${row.url})`,
    ),
    "",
    "The source-lock branch must continue to point at the exact source SHA. This patrol never directly merges the PR, publishes a package, creates a tag, or creates a release. Repository policy may arm GitHub auto-merge while every protected branch gate remains authoritative.",
    "",
    candidateStateMarker(state),
  ].join("\n");
}

export function markdown(result) {
  return [
    "## Buildchain Dev to Alpha candidate patrol",
    "",
    `Eligible: \`${result.decision.eligible}\` (${result.decision.reason})`,
    `Source: \`${result.decision.source.branch}@${result.decision.source.sha}\``,
    `Target: \`${result.decision.target.branch}@${result.decision.target.sha}\``,
    `Controller state: \`${result.controller.state}\``,
    `Release Train: \`${result.controller.trainRoot || "none"}\``,
    `Candidate generation: \`${result.controller.generation}\``,
    `Candidate tree: \`${result.controller.candidateTreeSha || "none"}\``,
    `Buildchain runtime: \`${result.controller.buildchainRuntimeSha || "none"}\``,
    `Drift observation: \`${result.drift?.observationRoot || "none"}\``,
    `Hold: \`${result.controller.holdRoot || "none"}\``,
    `Active candidate: ${result.controller.activeCandidate?.url || "none"}`,
    `Next candidate: \`${result.controller.nextCandidate?.sourceSha || "none"}\``,
    `Settlement action: \`${result.controller.settlementAction}\``,
    `Dry run: \`${result.dryRun}\``,
    `Pull request: ${result.pullRequest?.html_url || "not created"}`,
    "",
  ].join("\n");
}
