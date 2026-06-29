const { Octokit } = require('@octokit/rest');
const axios = require('axios');
const sortBy = require('lodash.sortby');
let octokit;

exports.getPulls = async function (argv) {
  octokit = new Octokit({
    auth: argv.token,
  });
  await getPrIssues(argv);
};

const getPrIssues = async (argv) => {
  const current = await getPr(argv, argv.pullRequestNumber);
  if (!current) {
    return;
  }
  const baseRef = current.base.ref;
  const headRef = current.head.ref;
  const mergedAt = mergedAtFormat(current.merged_at);
  const { devPulls, alphaPulls, releasePulls } = await getPrList(argv, baseRef, headRef);
  if (baseRef.startsWith('alpha/')) {
    const issues = await traversePrereleasePulls(argv, argv.pullRequestNumber, devPulls, alphaPulls, mergedAt);
    issuesHandle(argv, issues, false, current);
  }
  if (baseRef.startsWith('release/')) {
    const issues = await traverseReleasePr(argv, argv.pullRequestNumber, devPulls, alphaPulls, releasePulls, mergedAt);
    issuesHandle(argv, issues, true, current);
  }
};

const issuesHandle = async (argv, issues, closed, current) => {
  const { items } = issues.reduce(
    (acc, cur) => {
      if (!acc.set.has(cur.number)) {
        acc.items.push(cur);
      }
      acc.set.add(cur.number);
      return acc;
    },
    { items: [], set: new Set() },
  );
  for await (const issue of items) {
    closed && (await closeIssue(argv, issue.number));
    const status = closed ? 'Done' : 'Waiting test';
    const title = issue.title;
    const lastIdx = title.indexOf('#', 1);
    const itemId = title.slice(1, lastIdx);
    lastIdx > 1 && (await updateStatus(argv.mondayApi, issue.body, itemId, status, current.title));
  }
};

const getPrList = async (argv, baseRef, headRef) => {
  if (baseRef.startsWith('release/')) {
    return {
      devPulls: await getPrBatch(argv, { base: headRef.replace('alpha', 'dev') }),
      alphaPulls: await getPrBatch(argv, { base: headRef }),
      releasePulls: await getPrBatch(argv, { base: baseRef }),
    };
  }
  return {
    devPulls: await getPrBatch(argv, { base: headRef }),
    alphaPulls: await getPrBatch(argv, { base: baseRef }),
  };
};

const traverseReleasePr = async (argv, pullRequestNumber, devPulls, alphaPulls, releasePulls, rightRange) => {
  const idx = releasePulls.findIndex((v) => v.number === pullRequestNumber);
  const leftRange = releasePulls[idx + 1]?.merged_at || 0;
  const items = alphaPulls.filter((v) => v.merged_at >= leftRange && v.merged_at <= rightRange);
  let result = await findIssues(argv, pullRequestNumber);
  for await (const item of items) {
    result = [...result, ...(await traversePrereleasePulls(argv, item.number, devPulls, alphaPulls, item.merged_at))];
  }
  return result;
};

const traversePrereleasePulls = async (argv, pullRequestNumber, devPulls, alphaPulls, rightRange) => {
  const idx = alphaPulls.findIndex((v) => v.number === pullRequestNumber);
  const leftRange = alphaPulls[idx + 1]?.merged_at || 0;
  console.log(alphaPulls[idx].title, leftRange, rightRange);
  const items = devPulls.filter((v) => v.merged_at >= leftRange && v.merged_at <= rightRange);
  let result = await findIssues(argv, pullRequestNumber);
  for await (const pull of items) {
    result = [...result, ...(await findIssues(argv, pull.number))];
  }
  return result;
};

const getPrBatch = async (argv, option, page = 1) => {
  const per_page = 100;
  const pull = await octokit
    .request(`GET /repos/kungfu-trader/${argv.repo}/pulls`, {
      owner: argv.owner,
      repo: argv.repo,
      per_page,
      state: 'closed',
      page,
      ...option,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    .then((res) =>
      res.data.map((v) => ({
        number: v.number,
        title: v.title,
        merged_at: mergedAtFormat(v.merged_at),
        base: v.base.ref,
      })),
    )
    .catch((e) => {
      console.error(e.message);
      return [];
    });
  if (pull.length < per_page) {
    return pull.filter((v) => !!v.merged_at);
  }
  return sortBy([...pull, ...(await getPrBatch(argv, option, page + 1))], (v) => v.merged_at * -1);
};

const getPr = async (argv, pullRequestNumber) => {
  const pull = await octokit
    .request(`GET /repos/kungfu-trader/${argv.repo}/pulls/${pullRequestNumber}`, {
      owner: argv.owner,
      repo: argv.repo,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    .catch((e) => console.error('get pr error', e.message));

  const result = pull?.data?.merged ? pull.data : null;
  console.log('from request pull', result?.title, pullRequestNumber);
  return result;
};

const findIssues = async (argv, pullRequestNumber) => {
  const iss = await octokit
    .graphql(
      `query{
        repository(name: "${argv.repo}", owner: "${argv.owner}") {
          pullRequest(number: ${pullRequestNumber}) {
            title
            closingIssuesReferences (first: 100) {
              edges {
                node {
                  number
                  body
                  title,
                  url
                }
              }
            }
          }
        }
      } 
    `,
    )
    .catch((e) => console.error(e.message));
  const issues = iss?.repository?.pullRequest?.closingIssuesReferences?.edges || [];
  console.log(`pullRequestNumber: ${pullRequestNumber}, issues: ${issues.length}`);
  return issues.map((v) => v.node);
};

const mergedAtFormat = (merged_at) => {
  return merged_at ? Date.parse(new Date(merged_at)) : null;
};

const updateStatus = async function (mondayapi, boardId, itemId, status, prTitle) {
  if (!mondayapi || !boardId || !itemId) {
    console.log('empty monday:', boardId, itemId, mondayapi?.length);
    return;
  }
  const board = await mondayGetBoardInfo(mondayapi, boardId);
  if (!board) {
    return;
  }
  const statusColumnId = board.columns.find((v) => v.title.toUpperCase().includes('STATUS'))?.id;
  const statusVersionId = board.columns.find((v) => v.title.toUpperCase().includes('VERSION'))?.id;
  const launchGroupId = board.groups.find((v) => v.title.toUpperCase().includes('LAUNCH'))?.id;
  const waitGroupId = board.groups.find((v) => v.title.toUpperCase().includes('TEST'))?.id;
  const groupId = status === 'Done' ? launchGroupId : waitGroupId;
  const moveItemTOGroup = `move_item_to_group (item_id: ${itemId}, group_id: \"${groupId}\"){id}`;

  await mondayMutationMethod(
    mondayapi,
    `mutation{
    change_simple_column_value (board_id:${boardId}, item_id:${itemId}, column_id:\"${statusColumnId}\", value:\"${status}\"){id}
    ${groupId ? moveItemTOGroup : ''}
  }`,
    () => console.log(`updateStatus to monday completed boardId: ${boardId} itemId: ${itemId} status:${status}`),
    () => console.error(`updateStatus to monday failed ${e.message} boardId: ${boardId} itemId: ${itemId}`),
  );
  await mondayMutationMethod(
    mondayapi,
    `mutation{
    change_simple_column_value (board_id:${boardId}, item_id:${itemId}, column_id:\"${statusVersionId}\", value:\"${prTitle}\"){id}
  }`,
  );
};

const mondayMutationMethod = async (mondayapi, query, onSuccess, onError) => {
  return axios
    .post('https://api.monday.com/v2', JSON.stringify({ query }), {
      headers: {
        'Content-Type': 'application/json',
        Authorization: mondayapi,
        'API-Version': '2024-01',
      },
    })
    .then((res) => {
      if (res.data.errors) {
        throw new Error(res.data.errors?.[0]?.message);
      }
      onSuccess?.();
    })
    .catch((e) => {
      console.error(e.message);
      onError?.();
    });
};

const mondayGetBoardInfo = async (mondayapi, boardId) => {
  return axios
    .post(
      'https://api.monday.com/v2',
      JSON.stringify({
        query: `query {boards (ids: ${boardId}) {
            columns { id title }
            groups { id title }
          }}`,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: mondayapi,
          'API-Version': '2024-01',
        },
      },
    )
    .then((res) => {
      if (res.data.errors) {
        throw new Error(res.data.errors?.[0]?.message);
      }
      return res.data?.data?.boards?.[0];
    })
    .catch((e) => console.log(e?.message));
};

const closeIssue = function (argv, issue_number) {
  return octokit
    .request(`PATCH /repos/kungfu-trader/${argv.repo}/issues/${issue_number}`, {
      owner: argv.owner,
      repo: argv.repo,
      issue_number,
      state: 'closed',
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    .then(() => console.log(`close issue completed ${issue_number}`))
    .catch((e) => console.error(`close issue failed ${issue_number} ${e.message}`));
};
