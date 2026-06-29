const lib = (exports.lib = require("./lib"));
const core = require("@actions/core");
const github = require("@actions/github");

const main = async function () {
  const context = github.context;
  const argv = {
    apiKey: core.getInput("apiKey"),
    bucketRelease: core.getInput("bucket-release"),
    bucketPrebuilt: core.getInput("bucket-prebuilt"),
    baseId: core.getInput("airtable-baseid"),
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    pullRequestTitle: context.payload?.pull_request?.title,
  };
  lib.generateHTML(argv);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    // 设置操作失败时退出
    core.setFailed(error.message);
  });
}
