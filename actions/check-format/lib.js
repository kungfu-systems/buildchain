/* eslint-disable no-restricted-globals */
const github = require('@actions/github');
const fs = require('fs-extra');
const path = require('path');
const git = require('git-client');
// 开启子进程，用于在终端执行格式检查脚本
const { spawnSync } = require('child_process');

const spawnOpts = { shell: true, stdio: 'pipe', windowsHide: true };

function exec(cmd, args = [], opts = spawnOpts) {
  console.log('$', cmd, ...args);
  const result = spawnSync(cmd, args, opts);
  // filter:创建包含通过所提供的函数实现的测试的所有元素的新数组format
  // => : ES6写法
  const output = result.output.filter((e) => e && e.length > 0).toString();
  console.log(output);
  if (result.status !== 0) {
    throw new Error(`Failed with status ${result.status}`);
  }
  return output;
}

// ...args : 剩余参数；由没有对应形参的实参组成的一个数组
async function gitCall(...args) {
  console.log('$ git', ...args);
  const output = await git(...args);
  console.log(output);
  return output;
}

exports.checkFormat = async function (argv) {
  const jsonInfo = fs.readJSONSync('package.json');
  const hasFormat = jsonInfo.scripts.format;
  if (hasFormat !== undefined) {
    // format : 定义在package.json中的scripts
    exec('yarn', ['run', 'format']);
    const gitStatus = await gitCall('status', '--short');
    if (gitStatus) {
      console.log('\n! Found unformatted code');
      // 字符串拼接：`words + ${字符串变量}`
      exports.addPullRequestComment(argv, gitStatus);
      throw new Error(`Found unformatted code\n${gitStatus}`);
    }
  } else {
    console.log('[info] package.json does not define "format" action in scrips.');
  }
};

exports.addPullRequestComment = async function (argv, filesInfo) {
  const octokit = github.getOctokit(argv.token);
  const pullRequestQuery = await octokit.graphql(`
    query {
      repository(name: "${argv.repo}", owner: "${argv.owner}") {
        pullRequest(number: ${argv.pullRequestNumber}) { id }
      }
  }`);
  console.log(
    `[info] Found unformatted code in repo [${argv.owner}/${argv.repo}]'s ${argv.pullRequestNumber}th pull-request`,
  );
  const pullRequestID = pullRequestQuery.repository.pullRequest.id;
  const body = `Unformatted code:\n${filesInfo}`;
  await octokit.graphql(`mutation{addComment(input:{body:"${body}", subjectId:"${pullRequestID}"}){clientMutationId}}`);
};
