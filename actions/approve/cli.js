const lib = require('./lib.js');

const argv = require('yargs/yargs')(process.argv.slice(2))
  .option('token', { description: 'token', type: 'string' })
  .option('owner', { description: 'owner', type: 'string' })
  .option('repo', { description: 'repo', type: 'string' })
  .option('pullRequestNumber', { description: 'pullRequestNumber', type: 'number' })
  .help().argv;
console.log('owner', argv.owner, 'repo', argv.repo, 'pullRequest', argv.pullRequestNumber);
// node cli.js --token token --owner kungfu-trader --repo test-rollback-packages --pullRequestNumber 88
lib.approveAndMerge(argv).catch(console.error);
