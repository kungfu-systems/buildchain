import { update } from "./lib";
import { getInput, setFailed } from "@actions/core";
import { context } from "@actions/github";

const main = async function () {
  const argv = {
    token: getInput("token"),
    repo: getInput("repo"),
    repoIncludes: getInput("repo-includes"),
    repoInExcludes: getInput("repo-excludes"),
    pullRequestTitle: context.payload?.pull_request?.title,
  };
  await update(argv);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    setFailed(error.message);
  });
}
