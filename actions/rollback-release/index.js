/* eslint-disable no-restricted-globals */
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as lib from './lib.js';

export const main = async function () {
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

if (process.env.GITHUB_ACTION) {
  main().catch((error) => {
    console.log('test');
    console.error(error);
    core.setFailed(error.message);
  });
}

export { lib };
