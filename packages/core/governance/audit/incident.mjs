export async function reportGovernanceIncident({ github, context, auditRoot, nonQualifying }) {
  const title = "[governance] Managed zone is non-qualifying";
  const marker = "<!-- kungfu-github-governance-authority-drift -->";
  const body = [
    marker,
    "The scheduled GitHub governance authority audit failed closed.",
    "",
    `Non-qualifying repositories: ${nonQualifying}`,
    `Audit root: \`${auditRoot}\``,
    `Run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
    "",
    "Use the sanitized run artifact for exact remediation pointers. Do not paste private provider payloads into this issue.",
  ].join("\n");
  const open = await github.paginate(github.rest.issues.listForRepo, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: "open",
    per_page: 100,
  });
  const existing = open.find(
    (issue) =>
      issue.title === title && String(issue.body || "").includes(marker),
  );
  if (existing) {
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: existing.number,
      body,
    });
  } else {
    await github.rest.issues.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title,
      body,
    });
  }
}
