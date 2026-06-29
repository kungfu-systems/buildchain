const lib = (exports.lib = require('./lib.js'));
const core = require('@actions/core');
const github = require('@actions/github');

const main = async function () {
  const context = github.context;
  const pullRequestNumber = context.payload.pull_request.number;
  const argv = {
    token: core.getInput('token'),
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    pullRequestNumber: pullRequestNumber,
  };
  if (argv.token) {
    await lib.approveAndMerge(argv);
  }
};
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    core.setFailed(error.message);
  });
}
