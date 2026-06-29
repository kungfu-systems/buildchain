/* eslint-disable no-restricted-globals */
const lib = (exports.lib = require('./lib.js'));
const core = require('@actions/core');
const github = require('@actions/github');

const main = async function () {
  const context = github.context;
  const pullRequestNumber_ = () => (context.issue.number ? context.issue.number : context.payload.pull_request.number);
  const argv = {
    token: core.getInput('token'),
    owner: context.repo.owner,
    repo: context.repo.repo,
    pullRequestNumber: pullRequestNumber_(),
  };
  await lib.checkFormat(argv);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    // 设置操作失败时退出
    core.setFailed(error.message);
  });
}
