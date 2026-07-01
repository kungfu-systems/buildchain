import * as core from '@actions/core';
import * as github from '@actions/github';
import * as lib from './lib2.js';

export const main = async function () {
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

if (process.env.GITHUB_ACTION) {
  main().catch((error) => {
    console.error(error);
    // 设置操作失败时退出
    core.setFailed(error.message);
  });
}

export { lib };
