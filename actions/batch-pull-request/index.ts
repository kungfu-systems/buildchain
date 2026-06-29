import { batchPullRequest, npmrc, designatedPullRequest } from "./lib";
import { getInput, setFailed } from "@actions/core";

const main = async function () {
  const argv = {
    token: getInput("token"),
    branch: getInput("branch"),
    repo: getInput("repo"),
    version: getInput("version"),
    repoIncludes: getInput("repo-includes"),
    repoInExcludes: getInput("repo-excludes"),
    pullRequestTitle: getInput("pull-request-title"),
  };
  console.log(argv.token.length, argv.branch, argv.repo, argv.version);
  await npmrc(argv.token);
  argv.pullRequestTitle
    ? await designatedPullRequest(argv)
    : await batchPullRequest(argv);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    setFailed(error.message);
  });
}
