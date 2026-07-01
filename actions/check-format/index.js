/* eslint-disable no-restricted-globals */
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as lib from './lib.js';

export const main = async function () {
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

if (process.env.GITHUB_ACTION) {
  main().catch((error) => {
    console.error(error);
    // 设置操作失败时退出
    core.setFailed(error.message);
  });
}

export { lib };
