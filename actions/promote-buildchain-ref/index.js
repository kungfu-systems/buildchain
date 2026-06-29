const core = require("@actions/core");
const github = require("@actions/github");
const {
  parseTags,
  promoteBuildchainRefs,
} = require("./lib.js");

async function main() {
  const token = core.getInput("token", { required: true });
  const sha = core.getInput("sha", { required: true });
  const targetRef = core.getInput("target-ref", { required: true });
  const tagInput = core.getInput("tags");
  const tags = tagInput ? parseTags(tagInput) : undefined;
  const dryRun = core.getBooleanInput("dry-run");
  const allowRepository = core.getInput("allow-repository") || "kungfu-systems/buildchain";
  const octokit = github.getOctokit(token);
  const result = await promoteBuildchainRefs({
    octokit,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    sha,
    targetRef,
    tags,
    dryRun,
    allowRepository,
  });

  for (const update of result.updates) {
    console.log(`${update.action}: ${update.tag} -> ${update.sha}`);
  }
  core.setOutput("sha", result.sha);
  core.setOutput("tags", result.updates.map((update) => update.tag).join(","));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    core.setFailed(error.message);
  });
}
