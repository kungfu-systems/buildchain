const { Octokit } = require('@octokit/rest');
const github = require('@actions/github');

exports.approveAndMerge = async function (argv) {
  const ruleId = await getBranchProtectionRuleForAlpha(argv);
  if (!ruleId) {
    console.error('empty ruleId for alpha!');
    return;
  }
  const tag = await isBatchPullRequestTag(argv);
  if (!tag) {
    console.log('Not labeled batch_upgrade_alpha!');
    return;
  }
  await branchProtection(argv, false, ruleId);
  await merge(argv);
  await branchProtection(argv, true, ruleId);
};

const isBatchPullRequestTag = async function (argv) {
  const octokit = new Octokit({
    auth: argv.token,
  });
  try {
    console.log('owner', argv.owner, 'repo', argv.repo, 'pullRequest', argv.pullRequestNumber);
    const pullRequestDetail = await octokit.request(
      `GET /repos/kungfu-trader/${argv.repo}/pulls/${argv.pullRequestNumber}`,
      {
        owner: 'kungfu-trader',
        repo: argv.repo,
        pull_number: argv.pullRequestNumber,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    console.log('labels:', pullRequestDetail.data.labels);
    for (const label of pullRequestDetail.data.labels) {
      if (label.name == 'batch_upgrade_alpha') {
        return true;
      }
    }
  } catch (e) {
    console.error(e);
  }
  return false;
};

const updateBranch = async function (argv) {
  const octokit = new Octokit({
    auth: argv.token,
  });
  try {
    console.log('owner', argv.owner, 'repo', argv.repo, 'pullRequest', argv.pullRequestNumber);
    const up = await octokit.request(
      `PUT /repos/kungfu-trader/${argv.repo}/pulls/${argv.pullRequestNumber}/update-branch`,
      {
        headers: {
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    console.log('updateBranch ret:', up);
  } catch (e) {
    console.error(e);
  }
};

async function getBranchProtectionRuleForAlpha(argv) {
  let ruleId = '';
  try {
    const octokit = github.getOctokit(argv.token);
    const rulesQuery = await octokit.graphql(`
          query {
            repository(name: "${argv.repo}", owner: "kungfu-trader") {
              branchProtectionRules(first:100) {
                nodes {
                  id
                  pattern
                }
              }
            }
          }`);
    for (const rule of rulesQuery.repository.branchProtectionRules.nodes) {
      if (rule.pattern == 'alpha/*/*') {
        ruleId = rule.id;
      }
    }
  } catch (e) {
    console.error(e);
  }
  return ruleId;
}

const branchProtection = async function (argv, isProtect, ruleId) {
  const octokit = github.getOctokit(argv.token);
  const statusCheckContexts = '["verify"]';
  const mutation = `
      mutation {
        updateBranchProtectionRule(input: {
          branchProtectionRuleId: "${ruleId}"
          requiresApprovingReviews: ${isProtect},
          requiredApprovingReviewCount: 1,
          dismissesStaleReviews: ${isProtect},
          restrictsReviewDismissals: ${isProtect},
          requiresStatusChecks: ${isProtect},
          requiresCodeOwnerReviews: false,
          requiredStatusCheckContexts: ${statusCheckContexts},
          requiresStrictStatusChecks: ${isProtect},
          requiresConversationResolution: ${isProtect},
          isAdminEnforced: true,
          restrictsPushes: false,
          allowsForcePushes: false,
          allowsDeletions: false
        }) { clientMutationId }
      }
    `;
  await octokit.graphql(mutation);
};

const approve = async function (argv) {
  const octokit = new Octokit({
    auth: argv.token,
  });
  try {
    const ret = await octokit.request(
      `POST /repos/${argv.owner}/${argv.repo}/pulls/${argv.pullRequestNumber}/reviews`,
      {
        owner: argv.owner,
        repo: argv.repo,
        pull_number: argv.pullRequestNumber,
        event: 'APPROVE',
        headers: {
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    console.log('approve', ret);
  } catch (e) {
    console.error(e);
  }
};

const merge = async function (argv) {
  const octokit = new Octokit({
    auth: argv.token,
  });
  try {
    const ret = await octokit.request(`PUT /repos/kungfu-trader/${argv.repo}/pulls/${argv.pullRequestNumber}/merge`, {
      owner: 'kungfu-trader',
      repo: argv.repo,
      pull_number: 'PULL_NUMBER',
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    console.log('pull request', argv.pullRequestNumber, 'merge success!');
  } catch (e) {
    console.error(e);
  }
};
