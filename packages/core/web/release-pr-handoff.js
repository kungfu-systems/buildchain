import { urlsFromResult } from "./release-pr-summary.js";
function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalString(value = "") {
  return String(value || "").trim();
}

function slugify(value) {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "production"
  );
}

function runUrl({ serverUrl = "", repository = "", runId = "" } = {}) {
  if (!serverUrl || !repository || !runId) return "";
  return `${serverUrl.replace(/\/$/, "")}/${repository}/actions/runs/${runId}`;
}

export function releaseBranchName({
  prefix = "release/",
  channel = "production",
  sourceSha = "",
} = {}) {
  const normalizedPrefix = optionalString(prefix) || "release/";
  const normalizedChannel = slugify(channel || "production");
  const shortSha = requiredString(sourceSha, "sourceSha").slice(0, 12);
  return `${normalizedPrefix}${normalizedChannel}-${shortSha}`;
}

export function renderProductionReleasePrBody({
  stagingResult = {},
  sourceSha = "",
  artifactHash = "",
  releasePassportArtifact = "buildchain-web-surface-staging-release-passport",
  workflowRunUrl = "",
  productionReleaseLabel = "buildchain-release",
  branchName = "",
} = {}) {
  const urls = urlsFromResult(stagingResult);
  const urlLines = Object.entries(urls).length
    ? Object.entries(urls).map(([surface, url]) => `- ${surface}: ${url}`)
    : ["- (no staging URL reported)"];
  const passportLine = workflowRunUrl
    ? `[${releasePassportArtifact}](${workflowRunUrl})`
    : `\`${releasePassportArtifact}\``;
  return `<!-- buildchain:web-surface-production-release-pr -->
## Buildchain production release intent

Staging has been deployed from the current main commit. Review the staging URLs,
then merge this PR to approve production. Buildchain will only publish
production after it verifies that the merged PR is a same-repository release PR
with the required label.

### Staging URLs

${urlLines.join("\n")}

### Release Evidence

- Source SHA: \`${sourceSha}\`
- Artifact hash: \`${artifactHash || "not reported"}\`
- Staging release passport: ${passportLine}
- Required label: \`${productionReleaseLabel}\`
- Release branch: \`${branchName}\`

This PR intentionally contains one empty release-intent commit.`;
}

export function createProductionReleasePrHandoff({
  repository,
  sourceSha,
  stagingResult = {},
  productionReleaseLabel = "buildchain-release",
  productionReleaseHeadPrefix = "release/",
  productionReleaseChannel = "production",
  runId = "",
  serverUrl = "https://github.com",
  releasePassportArtifact = "buildchain-web-surface-staging-release-passport",
} = {}) {
  const [owner, repo] = requiredString(repository, "repository").split("/");
  if (!owner || !repo) throw new Error(`invalid repository: ${repository}`);
  const normalizedSourceSha = requiredString(sourceSha, "sourceSha");
  const label = requiredString(
    productionReleaseLabel,
    "productionReleaseLabel",
  );
  const branchName = releaseBranchName({
    prefix: productionReleaseHeadPrefix || "release/",
    channel: productionReleaseChannel || "production",
    sourceSha: normalizedSourceSha,
  });
  const workflowRunUrl = runUrl({ serverUrl, repository, runId });
  const title = `Release production from ${normalizedSourceSha.slice(0, 12)}`;
  const body = renderProductionReleasePrBody({
    stagingResult,
    sourceSha: normalizedSourceSha,
    artifactHash: stagingResult.artifactHash || "",
    releasePassportArtifact,
    workflowRunUrl,
    productionReleaseLabel: label,
    branchName,
  });
  const emptyCommitMessage = `buildchain release intent: ${productionReleaseChannel} ${normalizedSourceSha.slice(0, 12)}`;
  const bodyPath = ".buildchain/production-release-pr/body.md";
  const manualCommand = [
    "git fetch origin main",
    `git switch -C ${branchName} ${normalizedSourceSha}`,
    `git commit --allow-empty -m ${JSON.stringify(emptyCommitMessage)}`,
    `git push origin HEAD:${branchName}`,
    `gh pr create --repo ${repository} --base main --head ${branchName} --title ${JSON.stringify(title)} --body-file ${bodyPath}`,
  ].join(" && ");
  return {
    contract: "kungfu-buildchain-web-surface-production-release-pr-handoff",
    schemaVersion: 1,
    repository,
    owner,
    repo,
    base: "main",
    head: `${owner}:${branchName}`,
    branchName,
    sourceSha: normalizedSourceSha,
    title,
    body,
    label,
    productionReleaseChannel,
    releasePassportArtifact,
    workflowRunUrl,
    manualCommand,
    staging: {
      channel: stagingResult.channel || "",
      status: stagingResult.status || "",
      urls: urlsFromResult(stagingResult),
      artifactHash: stagingResult.artifactHash || "",
      target: stagingResult.target || "",
      manifestKey: stagingResult.manifestKey || "",
    },
  };
}

export function renderProductionReleasePrSummary(result = {}) {
  const status = result.status || result.action || "unknown";
  const lines = [
    "## Buildchain production release PR handoff",
    "",
    `- status: \`${status}\``,
    `- mode: \`${result.mode || "auto"}\``,
    `- source: \`${result.sourceSha || ""}\``,
    `- release branch: \`${result.branchName || ""}\``,
  ];
  if (result.pullUrl) lines.push(`- pull request: ${result.pullUrl}`);
  if (result.tokenSource)
    lines.push(`- token source: \`${result.tokenSource}\``);
  if (result.appTokenStatus)
    lines.push(`- app token status: \`${result.appTokenStatus}\``);
  if (result.error?.message)
    lines.push(`- error: \`${result.error.message.replace(/`/g, "'")}\``);
  if (result.manualCommand) {
    lines.push(
      "",
      "Manual PR creation command:",
      "",
      "```bash",
      result.manualCommand,
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}
