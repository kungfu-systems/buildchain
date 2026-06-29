const lib = (exports.lib = require('./lib2.js'));
const core = require('@actions/core');
const github = require('@actions/github');

const main = async function () {
  const context = github.context;
  const pullRequestNumber = context.payload.pull_request.number;
  const argv = {
    token: core.getInput('token'),
    mondayApi: core.getInput('monday_api_key'),
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    pullRequestNumber: pullRequestNumber,
  };
  console.log('mondayApi length:', argv.mondayApi.length);
  await lib.getPulls(argv, pullRequestNumber);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    // 设置操作失败时退出
    core.setFailed(error.message);
  });
}
