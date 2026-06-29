/* eslint-disable no-restricted-globals */
const lib = (exports.lib = require('./lib.js'));
const core = require('@actions/core');
const github = require('@actions/github');

const main = async function () {
  const context = github.context;
  const headRef = process.env.GITHUB_HEAD_REF || context.ref;
  const baseRef = process.env.GITHUB_BASE_REF || context.ref;
  const argv = {
    token: core.getInput('token'),
    owner: context.repo.owner,
    repo: context.repo.repo,
    headRef: headRef,
    baseRef: baseRef,
  };
  await lib.rollbackRelease(argv);
};

if (require.main === module) {
  main().catch((error) => {
    console.log('test');
    console.error(error);
    core.setFailed(error.message);
  });
}
