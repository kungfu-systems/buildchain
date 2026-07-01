import * as core from '@actions/core';
import * as github from '@actions/github';
import * as lib from './lib.js';

export const main = async function () {
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

if (process.env.GITHUB_ACTION) {
  main().catch((error) => {
    console.error(error);
    core.setFailed(error.message);
  });
}

export { lib };
