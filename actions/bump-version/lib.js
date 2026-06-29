import * as github from '@actions/github';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'git-client';
import semver from 'semver';
import { spawnSync } from 'node:child_process';
import {
  commandForVersion,
  detectPackageManager,
  getWorkspaceInfo,
} from '../../packages/core/package-manager.js';

const ProtectedBranchPatterns = ['main', 'release/*/*', 'alpha/*/*', 'dev/*/*'];

const bumpOpts = { dry: false };
const spawnOpts = { shell: true, stdio: 'pipe', windowsHide: true };

function hasLerna(cwd) {
  return fs.existsSync(path.join(cwd, 'lerna.json'));
}

function makeNpmrcForLerna(argv) {
  // https://github.com/lerna/lerna/issues/2404
  // Note that the only .npmrc file respected by Lerna is the project root. (lerna@4.0.0)
  const lineRegistry = `@${argv.owner}:registry=https://npm.pkg.github.com/`;
  const lineAuthToken = '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}';
  const lineAwaysAuth = 'always-auth=false';
  const npmrcContent = `${lineRegistry}${os.EOL}${lineAuthToken}${os.EOL}${lineAwaysAuth}${os.EOL}`;
  console.log('> write .npmrc');
  if (bumpOpts.dry) {
    console.log(npmrcContent);
    return;
  }
  fs.writeFileSync('.npmrc', npmrcContent);
}

function getCurrentVersion(cwd) {
  const configPath = path.join(cwd, hasLerna(cwd) ? 'lerna.json' : 'package.json');
  const config = JSON.parse(fs.readFileSync(configPath));
  return semver.parse(config.version);
}

function getLooseVersion(version) {
  return `${version.major}.${version.minor}`;
}

function getChannel(ref) {
  return ref.replace(/^refs\/heads\//, '').split('/')[0];
}

function getBumpKeyword(cwd, headRef, baseRef, loose = false) {
  const version = getCurrentVersion(cwd);
  const looseVersionNumber = Number(getLooseVersion(version));
  const lastLooseVersionNumber = looseVersionNumber - 0.1;
  const headChannel = getChannel(headRef);
  const baseChannel = getChannel(baseRef);
  const key = `${headChannel}->${baseChannel}`;
  const keywords = {
    'dev->alpha': 'prerelease',
    'alpha->release': 'patch',
    'release->main': 'preminor',
    'release->release': 'preminor',
    'main->main': 'premajor',
  };

  const lts = baseChannel === 'release' && baseRef.split('/').pop() === 'lts';
  const preminor = headChannel === 'release' && (baseChannel === 'main' || lts);

  if (headRef.replace(headChannel, '') !== baseRef.replace(baseChannel, '') && !preminor) {
    throw new Error(`Versions not match for head/base refs: ${headRef} -> ${baseRef}`);
  }

  if (headChannel === 'main') {
    // for main -> main
    return keywords[key];
  }

  const headMatch = headRef.match(/(\w+)\/v(\d+)\/v(\d+\.\d)/);
  const mismatchMsg = `The version of head ref ${headRef} does not match current ${version}`;

  if (!headMatch) {
    throw new Error(mismatchMsg);
  }

  const headMajor = Number(headMatch[2]);
  const headLoose = Number(headMatch[3]);

  if (headMajor !== version.major || headLoose > looseVersionNumber) {
    throw new Error(mismatchMsg);
  }

  if (headLoose < lastLooseVersionNumber) {
    throw new Error(mismatchMsg);
  }

  if (headLoose === lastLooseVersionNumber && !loose) {
    throw new Error(mismatchMsg);
  }

  return keywords[key];
}

function exec(cmd, args = [], opts = spawnOpts) {
  console.log('$', cmd, ...args);
  if (bumpOpts.dry) {
    return;
  }
  const result = spawnSync(cmd, args, opts);
  const output = result.output.filter((e) => e && e.length > 0).toString();
  console.log(output);
  if (result.status !== 0) {
    throw new Error(`Failed with status ${result.status}`);
  }
}

async function gitCall(...args) {
  console.log('$ git', ...args);
  if (bumpOpts.dry) {
    return;
  }
  const output = await git(...args);
  console.log(output);
}

async function deleteLocalTagIfExists(tag) {
  if (bumpOpts.dry) {
    console.log(`$ git tag -d ${tag} # if local tag exists`);
    return;
  }
  try {
    await git('rev-parse', '--verify', `refs/tags/${tag}`);
  } catch {
    return;
  }
  await gitCall('tag', '-d', tag);
}

async function octokitGraphqlCall(argv, query) {
  const octokit = github.getOctokit(argv.token);
  const result = await octokit.graphql(query, {
    headers: {
      Connection: 'close',
    },
  });
  return result;
}

async function bumpCall(argv, keyword, message, tag = true) {
  const version = getCurrentVersion(argv.cwd);
  const nextVersion = semver.inc(version, keyword, 'alpha'); // Get next version to make up message
  const nonReleaseMessageOpt = ['--message', message ? `"${message}"` : `"Move on to v${nextVersion}"`];
  const messageOpt = keyword === 'patch' ? [] : nonReleaseMessageOpt;
  const tagOpt = tag ? [] : ['--no-git-tag-version'];

  if (tag) {
    await deleteLocalTagIfExists(`v${nextVersion}`);
  }

  if (hasLerna(argv.cwd)) {
    if (keyword === 'patch' || keyword === 'prepatch') {
      // lerna requires a valid branch to bump
      const lernaBumpBranch = `release/v${version.major}/lerna-bump-patch`;
      await gitCall('switch', '-C', lernaBumpBranch, 'HEAD');
    }
    const forceOpt = keyword === 'prerelease' && !message ? ['--force-publish'] : [];
    const lernaOpt = ['--yes', '--no-push', ...messageOpt, ...tagOpt, ...forceOpt];
    exec('lerna', ['version', `${keyword}`, ...lernaOpt]);
  } else {
    const manager = detectPackageManager(argv.cwd).name;
    const versionCommand = commandForVersion(manager, keyword, {
      preid: 'alpha',
      message: messageOpt[1],
      tag,
    });
    exec(versionCommand.cmd, versionCommand.args);
  }
}

async function publishCall(argv) {
  const tryPublish = (cwd) => {
    const packageConfig = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json')));
    if (!packageConfig.private) {
      const execOpts = { cwd: cwd, ...spawnOpts };
      exec('npm', ['publish'], execOpts);
    } else {
      console.log(`> bypass private package ${packageConfig.name}`);
    }
  };
  if (hasLerna(argv.cwd)) {
    // https://github.com/lerna/lerna/issues/2404
    // Lerna publish is avoided here; publish workspace packages with npm.
    console.log('> detected lerna, use package-manager workspace metadata for npm publish');
    const workspaces = getWorkspaceInfo(argv.cwd);
    if (Object.keys(workspaces).length > 0) {
      for (const key in workspaces) {
        tryPublish(path.join(argv.cwd, workspaces[key].location));
      }
    } else {
      throw new Error('Found lerna.json without package workspace metadata, please configure workspaces/packages.');
    }
  } else {
    console.log('> use npm publish');
    tryPublish(argv.cwd);
  }
}

async function getBranchProtectionRulesMap(argv) {
  const ruleIds = {};

  const { repository } = await octokitGraphqlCall(
    argv,
    `query{repository(name:"${argv.repo}",owner:"${argv.owner}"){id}}`,
  );

  const rulesQuery = await octokitGraphqlCall(
    argv,
    `
        query {
          repository(name: "${argv.repo}", owner: "${argv.owner}") {
            branchProtectionRules(first:100) {
              nodes {
                id
                creator { login }
                pattern
              }
            }
          }
        }`,
  );

  for (const rule of rulesQuery.repository.branchProtectionRules.nodes) {
    ruleIds[rule.pattern] = rule.id;
  }

  for (const pattern of ProtectedBranchPatterns.filter((p) => !(p in ruleIds))) {
    console.log(`> creating protection rule for branch name pattern ${pattern}`);
    const { createBranchProtectionRule } = await octokitGraphqlCall(
      argv,
      `
      mutation {
        createBranchProtectionRule(input: {
          repositoryId: "${repository.id}"
          pattern: "${pattern}"
        }) {
          branchProtectionRule { id }
        }
      }
    `,
    );
    ruleIds[pattern] = createBranchProtectionRule.branchProtectionRule.id;
  }
  return ruleIds;
}

async function ensureBranchesProtection(argv) {
  if (!argv.protection) return;

  const ruleIds = await getBranchProtectionRulesMap(argv);
  for (const pattern in ruleIds) {
    const id = ruleIds[pattern];
    const notDev = pattern.split('/')[0] !== 'dev';
    const restrictsPushes = notDev || argv.protectDevBranches;
    const isRelease = pattern.split('/')[0] === 'release';
    const statusCheckContexts = '["verify"]';
    const mutation = `
      mutation {
        updateBranchProtectionRule(input: {
          branchProtectionRuleId: "${id}"
          requiresApprovingReviews: ${restrictsPushes},
          requiredApprovingReviewCount: ${restrictsPushes ? 1 : 0},
          dismissesStaleReviews: true,
          restrictsReviewDismissals: true,
          requiresStatusChecks: true,
          requiresCodeOwnerReviews: ${isRelease},
          requiredStatusCheckContexts: ${notDev ? statusCheckContexts : '[]'},
          requiresStrictStatusChecks: true,
          requiresConversationResolution: true,
          isAdminEnforced: true,
          restrictsPushes: ${restrictsPushes},
          allowsForcePushes: false,
          allowsDeletions: false
        }) { clientMutationId }
      }
    `;
    console.log(`> ensure protection for branch name pattern ${pattern}`);
    if (bumpOpts.dry) {
      console.log(mutation);
      continue;
    }
    await octokitGraphqlCall(argv, mutation);
  }
}

async function suspendBranchesProtection(argv, branchPatterns = ProtectedBranchPatterns) {
  if (!argv.protection) return;

  const ruleIds = await getBranchProtectionRulesMap(argv);
  for (const pattern of branchPatterns) {
    const id = ruleIds[pattern];
    const mutation = `
      mutation {
        updateBranchProtectionRule(input: {
          branchProtectionRuleId: "${id}"
          requiresApprovingReviews: false,
          requiredApprovingReviewCount: 0,
          dismissesStaleReviews: false,
          restrictsReviewDismissals: false,
          requiresStatusChecks: false,
          requiresCodeOwnerReviews: false,
          requiresStrictStatusChecks: false,
          requiresConversationResolution: false,
          isAdminEnforced: true,
          restrictsPushes: false,
          allowsForcePushes: true,
          allowsDeletions: false
        }) { clientMutationId }
      }
    `;
    console.log(`> suspend protection for branch name pattern ${pattern}`);
    if (bumpOpts.dry) {
      console.log(mutation);
      continue;
    }
    await octokitGraphqlCall(argv, mutation);
  }
}

async function mergeCall(argv, keyword) {
  const pushTargets = {
    premajor: ['release', 'alpha', 'dev'],
    preminor: ['release', 'alpha', 'dev'],
    patch: ['release', 'alpha', 'dev'],
    prerelease: ['dev'],
  };
  const branchPatterns = pushTargets[keyword].map((p) => `${p}/*/*`);
  await suspendBranchesProtection(argv, branchPatterns).catch(console.error);

  const octokit = github.getOctokit(argv.token);
  const headVersion = getCurrentVersion(argv.cwd);

  const pushTag = (tag) => gitCall('push', '-f', 'origin', `HEAD:refs/tags/${tag}`);
  const pushAlphaVersionTag = (v) => pushTag(`v${getLooseVersion(v)}-alpha`);
  const pushLooseVersionTag = (v) => pushTag(`v${getLooseVersion(v)}`);
  const pushMajorVersionTag = (v) =>
    octokit.rest.git
      .getRef({
        owner: argv.owner,
        repo: argv.repo,
        ref: `tags/v${v.major}.${v.minor + 1}`,
      })
      .catch(() => pushTag(`v${v.major}`));

  await pushAlphaVersionTag(headVersion);

  const pushVersionTags = {
    premajor: async () => {
      await gitCall('push', '-f', 'origin', `HEAD~1:refs/heads/release/v${argv.version.major}/lts`);
    },
    preminor: async () => {},
    patch: async (version) => {
      // Track loose version ${major.minor} on release channel
      await pushLooseVersionTag(version);
      // Track major version on release channel
      await pushMajorVersionTag(version);
      // Push release tag
      await gitCall('push', '-f', 'origin', `HEAD:refs/tags/v${version}`);
      // Push release commit
      if (argv.skipBaseBranchPush) {
        console.log(`> skip pushing release commit to protected base branch ${argv.baseRef}`);
      } else {
        await gitCall('push', '-f', 'origin', `HEAD:refs/heads/${argv.baseRef}`);
      }
      // Prepare new prerelease version for alpha channel
      await bumpCall(argv, 'prerelease');
      await pushAlphaVersionTag(getCurrentVersion(argv.cwd));
    },
    prerelease: async () => {
      await gitCall('push', '-f', 'origin', `HEAD~1:refs/tags/v${argv.version}`);
    },
  };

  await pushVersionTags[keyword](headVersion);

  const currentVersion = getCurrentVersion(argv.cwd); // Version might be changed after patch bump
  const looseVersion = getLooseVersion(currentVersion);
  const nextAlphaVersion = semver.inc(currentVersion, 'prepatch', 'alpha');
  const nextVersion = currentVersion.prerelease.length ? currentVersion : nextAlphaVersion;

  const { data: alphaVersionRef } = await octokit.rest.git.getRef({
    owner: argv.owner,
    repo: argv.repo,
    ref: `tags/v${looseVersion}-alpha`,
  });

  const mergeRemoteChannel = async (channelRef) => {
    console.log(`> merge ${argv.repo}/v${looseVersion} into ${argv.repo}/${channelRef}`);
    if (bumpOpts.dry) {
      return;
    }
    const { data: branch } = await octokit.rest.git
      .getRef({
        owner: argv.owner,
        repo: argv.repo,
        ref: `heads/${channelRef}`,
      })
      .catch(() =>
        octokit.rest.git.createRef({
          owner: argv.owner,
          repo: argv.repo,
          ref: `refs/heads/${channelRef}`,
          sha: alphaVersionRef.object.sha,
        }),
      );
    const merge = await octokit.rest.repos.merge({
      owner: argv.owner,
      repo: argv.repo,
      base: branch.ref,
      head: alphaVersionRef.object.sha,
      commit_message: `Update ${channelRef} to work on ${nextVersion}`,
    });
    if (merge.status !== 201 && merge.status !== 204) {
      console.error(merge);
      throw new Error(`Merge failed with status ${merge.status}`);
    }
  };

  const mergeTargets = {
    premajor: ['release', 'alpha', 'dev'],
    preminor: ['release', 'alpha', 'dev'],
    patch: ['alpha'],
    prerelease: ['dev'],
  };
  const versionRef = `v${currentVersion.major}/v${currentVersion.major}.${currentVersion.minor}`;

  console.log(`${os.EOL}# https://docs.github.com/en/rest/reference/repos#merge-a-branch${os.EOL}`);
  if (argv.skipChannelBranchMerge) {
    console.log(`> skip merging version tag into protected channel branches: ${mergeTargets[keyword].join(', ')}`);
  } else {
    for (const channel of mergeTargets[keyword]) {
      await mergeRemoteChannel(`${channel}/${versionRef}`);
    }
  }

  if (keyword === 'patch') {
    // Prepare new prerelease version for dev channel
    const devChannel = `dev/${versionRef}`;
    const alphaChannel = `alpha/${versionRef}`;
    const oriAlphaChannel = `origin/alpha/${versionRef}`;
    const lernaBumpBranch = `release/v${currentVersion.major}/lerna-bump-patch`;
    await gitCall('fetch');
    await gitCall('switch', '-c', devChannel, `origin/${devChannel}`);
    await bumpCall(argv, 'prepatch', 'auto', false);
    await gitCall('commit', '-a', '-m', `Update ${devChannel} to work on ${nextVersion}`);
    await gitCall('fetch', 'origin', alphaChannel);
    if (hasLerna(argv.cwd)) {
      await gitCall('switch', devChannel);
      await gitCall('merge', '--no-commit', lernaBumpBranch);
    }
    await gitCall('merge', '--no-ff', oriAlphaChannel, '-m', `Merge ${oriAlphaChannel} into ${devChannel}`);
    await gitCall('push', 'origin', `HEAD:${devChannel}`);
    await gitCall('switch', argv.baseRef);
  }
  await ensureBranchesProtection(argv).catch(console.error);
  if (argv.resetDefaultBranch) {
    await resetDefaultBranch(argv);
  } else {
    console.log('> skip resetting default branch');
  }
}

async function resetDefaultBranch(argv) {
  const octokit = github.getOctokit(argv.token);
  const lastDevVersion = await octokitGraphqlCall(
    argv,
    `
    query {
      repository(owner: "${argv.owner}", name: "${argv.repo}") {
        refs(refPrefix: "refs/heads/dev/", last: 1) {
          edges {
            node {
             name
            }
          }
        }
      }
    }`,
  );
  if (typeof lastDevVersion.repository.refs.edges[0] === 'undefined') {
    return;
  }
  const tempStoreName = lastDevVersion.repository.refs.edges[0].node.name;
  const lastDevName = 'dev/' + tempStoreName;
  await octokit.request('PATCH /repos/{owner}/{repo}', {
    owner: argv.owner,
    repo: argv.repo,
    default_branch: lastDevName,
  });
}

function setOpts(argv) {
  bumpOpts.dry = argv.dry;
}

const currentVersion = () => getCurrentVersion(process.cwd());

const getBumpKeywordFromArgv = (argv) => getBumpKeyword(argv.cwd, argv.headRef, argv.baseRef);

const ensureLerna = (argv) => {
  if (hasLerna(argv.cwd)) {
    const result = spawnSync('lerna', ['--version'], spawnOpts);
    if (result.status !== 0) {
      exec('npm', ['install', '-g', 'lerna@^5.0.0']);
    }
  }
};

const tryBump = (argv) => bumpCall(argv, getBumpKeyword(argv.cwd, argv.headRef, argv.baseRef));

const tryPublish = async (argv) => {
  if (argv.publish) {
    process.env.NODE_AUTH_TOKEN = argv.token;
    const keyword = getBumpKeyword(argv.cwd, argv.headRef, argv.baseRef);
    if (keyword === 'patch' || keyword === 'prerelease') {
      await publishCall(argv);
    }
  }
};

const tryMerge = (argv) => mergeCall(argv, getBumpKeyword(argv.cwd, argv.headRef, argv.baseRef, true));

const verify = async (argv) => {
  const keyword = getBumpKeyword(argv.cwd, argv.headRef, argv.baseRef);
  if (!keyword) {
    throw new Error(`No rule to bump for head/base refs: ${argv.headRef} -> ${argv.baseRef}`);
  }
  const octokit = github.getOctokit(argv.token);
  try {
    // https://octokit.github.io/rest.js/v20#actions-list-workflow-runs
    const queryWorkflowRuns = await octokit.rest.actions.listWorkflowRuns({
      owner: argv.owner,
      repo: argv.repo,
      workflow_id: 'release-verify.yml',
      branch: argv.headRef,
      per_page: 6,
    });
    if (queryWorkflowRuns.status === 200) {
      console.log(`> workflow release-verify triggered by commit ${argv.commitId}`);
    }
    const workflowRuns = queryWorkflowRuns.data.workflow_runs;
    for (const run of workflowRuns.slice(1)) {
      const commit = run.head_commit;
      if (run.head_sha === argv.commitId) {
        continue;
      }
      console.debug(`> found workflow run #${run.run_number} with status [${run.status}] for commit ${run.head_sha}`);
      if (run.status === 'completed') {
        continue;
      }
      console.log(
        `> cancel workflow run #${run.run_number} committed by ${commit.committer.name} with "${commit.message}"`,
      );
      await octokit.rest.actions.cancelWorkflowRun({ owner: argv.owner, repo: argv.repo, run_id: run.id });
    }
  } catch (e) {
    console.error(e);
  }
  return keyword;
};

export {
  currentVersion,
  ensureBranchesProtection,
  ensureLerna,
  exec,
  getBumpKeywordFromArgv as getBumpKeyword,
  getChannel,
  gitCall,
  resetDefaultBranch,
  setOpts,
  suspendBranchesProtection,
  tryBump,
  tryMerge,
  tryPublish,
  verify,
};
