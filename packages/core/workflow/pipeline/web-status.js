const labels = {
  admission: "Source admission",
  build: "Product verification",
  review: "Protected review",
  warrant: "Delivery qualification",
  merge: "Protected integration",
  publish: "Product publication",
  distribution: "Distribution",
  "next-development": "Next development version",
};
const safe = (value) =>
  String(value || "")
    .replace(/[\r\n|]/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]()]/gu, (character) => `\\${character}`)
    .slice(0, 1000);

export function pipelineWebStatus(observed, discussionUrl = "") {
  const { intent, attempt } = observed;
  const repositoryUrl = `https://github.com/${intent.repository}`;
  const current = observed.history.at(-1);
  if (!current) throw new Error("Pipeline status requires an admitted attempt");
  const table = [
    "| Step | State |",
    "| --- | --- |",
    ...intent.expectedNodes.map(
      (phase) =>
        `| ${labels[phase]} | ${safe(observed.phases[phase]?.payload.state || "pending")} |`,
    ),
  ].join("\n");
  const lines = [
    `## Buildchain · PR #${intent.source.pullRequest}`,
    `Status: **${safe(observed.status)}**. ${safe(observed.reason)}`,
    `Attempt: \`${attempt}\``,
    `[Pull request](${repositoryUrl}/pull/${intent.source.pullRequest}) · ` +
      `[Source ${current.generation.source.commit.slice(0, 7)}](${repositoryUrl}/commit/${current.generation.source.commit})`,
    table,
  ];
  const publisher = [...observed.history]
    .reverse()
    .find(
      (item) =>
        item.generation.id === current.generation.id &&
        item.phases.publish?.payload.state === "success",
    );
  const published = Boolean(publisher);
  if (published && observed.missing.length)
    lines.push(
      `Publication succeeded and its immutable results remain preserved. The whole attempt is incomplete: ${observed.missing.map((phase) => labels[phase]).join(", ")}.`,
    );
  if (publisher && publisher.identity.id !== current.identity.id)
    lines.push(
      `Publication succeeded in predecessor \`${publisher.identity.id}\`. Current qualification and remaining steps are shown separately above.`,
    );
  if (current.identity.predecessor)
    lines.push(
      `Recovered from \`${current.identity.predecessor}\`; its original evidence remains in history.`,
    );
  if (observed.status !== "complete")
    lines.push(
      `[Recover this attempt](${repositoryUrl}/actions/workflows/buildchain-recover.yml): choose Run workflow and enter the exact attempt above. Select a repaired runtime only when needed.`,
    );
  lines.push(
    "Execution links provide the provider's ordinary cancellation control. Cancellation stops remaining work; it does not undo completed publication.",
  );
  const runs = [
    ...new Map(
      current.runs.map((run) => [`${run.runId}:${run.runAttempt}`, run]),
    ).values(),
  ];
  for (const run of runs.slice(-10))
    lines.push(
      `[Execution ${run.runId}, attempt ${run.runAttempt}](${repositoryUrl}/actions/runs/${run.runId}/attempts/${run.runAttempt})`,
    );
  if (discussionUrl) {
    const url = new URL(discussionUrl);
    if (
      url.origin !== "https://github.com" ||
      !url.pathname.startsWith(`/${intent.repository}/discussions/`) ||
      !/\/discussions\/[1-9][0-9]*$/u.test(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error(
        "Pipeline evidence link belongs to another provider or repository",
      );
    lines.push(`[Retained evidence](${discussionUrl})`);
  }
  return `${lines.join("\n\n")}\n`;
}

export async function projectPipelineStatus(session, { project, core }) {
  let result;
  try {
    result = await project(session);
  } catch {
    core.warning(
      "Discussion projection unavailable; canonical attempt evidence remains retained.",
    );
  }
  const observed = await session.journal.read();
  await core.summary.addRaw(pipelineWebStatus(observed, result?.url)).write();
  return result || { url: "", journalHead: observed.head };
}
