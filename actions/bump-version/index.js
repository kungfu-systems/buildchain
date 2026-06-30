import * as lib from './lib.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import * as core from './runtime-core.js';
import { context, githubClient } from './runtime-github.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPullRequestNumber() {
  const issue = context.issue;
  return issue.number ? issue.number : context.payload.pull_request.number;
}

const setup = async function (argv) {
  if (context.eventName === 'pull_request') {
    const octokit = githubClient(argv.token);
    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner: argv.owner,
      repo: argv.repo,
      pull_number: getPullRequestNumber(),
    });
    const merge = argv.action === 'auto' || argv.action === 'postbuild';
    if (merge && !pullRequest.merged) {
      throw new Error(`Pull request [${pullRequest.html_url}] must be merged to perform action ${argv.action}`);
    }
    argv.pullRequest = pullRequest;
  }
  if (context.eventName === 'workflow_dispatch') {
    throw new Error('Manual bump-version dispatch is not supported; use a protected channel PR');
  }
  await lib.gitCall('config', '--global', 'user.name', argv.actor);
  await lib.gitCall('config', '--global', 'user.email', `${argv.actor}@users.noreply.github.com`);
  lib.ensureLerna(argv);
};

const teardown = async function (argv) {
  if (context.eventName === 'pull_request' && argv.action === 'verify') {
    const keyword = lib.getBumpKeyword(argv);
    const octokit = githubClient(argv.token);
    const title = {
      premajor: (v) => `Prepare v${semver.inc(v, 'major')}`,
      preminor: (v) => `Prepare v${semver.inc(v, 'minor')}`,
      patch: (v) => `Release v${v.prerelease.length ? semver.inc(v, 'patch') : v}`,
      prerelease: (v) => `Prerelease v${v}`,
    };
    const mutation = `mutation {
                updatePullRequest(input: {
                    pullRequestId: "${argv.pullRequest.node_id}"
                    title: "${title[keyword](lib.currentVersion())}"
                }) { pullRequest { id } }
            }`;
    await octokit.graphql(mutation);
  }
};

const prebuild = async (argv) => {
  core.setOutput('prebuild-version', `v${lib.currentVersion()}`);
  if (lib.getBumpKeyword(argv) === 'patch') {
    // The release version commit must be made before build to have the right release info.
    await lib.tryBump(argv);
  }
  core.setOutput('version', `v${lib.currentVersion()}`);
};

const postbuild = async (argv) => {
  await lib.tryPublish(argv);
  if (lib.getBumpKeyword(argv) !== 'patch') {
    // The next prerelease version commit must be made after build to update tracking branches.
    await lib.tryBump(argv);
  }
  await lib.tryMerge(argv);
  core.setOutput('postbuild-version', `v${lib.currentVersion()}`);
};

const tryClosePullRequest = async (error) => {
  const token = core.getInput('token');
  const headRef = process.env.GITHUB_HEAD_REF || context.ref;
  const baseRef = process.env.GITHUB_BASE_REF || context.ref;
  if (context.eventName === 'pull_request' && core.getInput('action') === 'verify') {
    const repo = context.repo;
    const octokit = githubClient(token);
    const pullRequestQuery = await octokit.graphql(`
            query {
            repository(name: "${repo.repo}", owner: "${repo.owner}") {
                pullRequest(number: ${getPullRequestNumber()}) { id }
            }
        }`);
    const pullRequestId = pullRequestQuery.repository.pullRequest.id;
    const body = `Invalid Pull Request from ${headRef} to ${baseRef} for version ${lib.currentVersion()}: ${
      error.message
    }`;
    await octokit.graphql(`mutation{addComment(input:{subjectId:"${pullRequestId}",body:"${body}"}){subject{id}}}`);
    await octokit.graphql(
      `mutation {updatePullRequest(input:{pullRequestId:"${pullRequestId}", state:CLOSED}) {pullRequest{id}}}`,
    );
  }
};

const actions = {
  auto: async (argv) => {
    await prebuild(argv);
    await postbuild(argv);
  },
  prebuild: prebuild,
  postbuild: postbuild,
  verify: lib.verify,
};

const main = async function () {
  const headRef = process.env.GITHUB_HEAD_REF || context.ref;
  const baseRef = process.env.GITHUB_BASE_REF || context.ref;
  const argv = {
    cwd: process.cwd(),
    owner: context.repo.owner,
    repo: context.repo.repo,
    actor: context.actor,
    token: core.getInput('token'),
    action: core.getInput('action'),
    publish: core.getInput('no-publish') === 'false',
    protection: core.getInput('no-protection') === 'false',
    protectDevBranches: core.getInput('protect-dev-branches') === 'true',
    resetDefaultBranch: core.getInput('reset-default-branch') !== 'false',
    skipBaseBranchPush: core.getInput('skip-base-branch-push') === 'true',
    skipChannelBranchMerge: core.getInput('skip-channel-branch-merge') === 'true',
    commitId: context.sha,
    headRef: headRef,
    baseRef: baseRef,
    keyword: lib.getBumpKeyword({ cwd: process.cwd(), headRef: headRef, baseRef: baseRef }),
    version: lib.currentVersion(),
  };

  core.setOutput('keyword', argv.keyword);
  await setup(argv);
  await actions[argv.action](argv);
  await teardown(argv);
};

if (process.env.GITHUB_ACTION) {
  const configPath = path.join(path.dirname(__dirname), 'package.json'); // Find package.json for dist/index.js
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : {};
  if (
    config.name &&
    (process.env.GITHUB_ACTION_REPOSITORY === config.name.slice(1) ||
      process.env.KUNGFU_ACTION_BUMP_VERSION_ALLOW_LOCAL === 'true')
  ) {
    main().catch((error) => {
      console.error(error);
      core.setFailed(error.message);
      tryClosePullRequest(error).catch(console.error);
    });
  }
}

export { actions, lib, setup, teardown };
