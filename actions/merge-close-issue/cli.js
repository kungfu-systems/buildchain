import { getPulls } from './lib.js';
import yargs from 'yargs/yargs';

const argv = yargs(process.argv.slice(2))
  .option('token', { description: 'token', type: 'string' })
  .option('owner', { description: 'owner', type: 'string' })
  .option('repo', { description: 'repo', type: 'string' })
  .option('pullRequestNumber', { description: 'pullRequestNumber', type: 'number' })
  .help().argv;

// node cli.js --token token --owner kungfu-trader --repo test-rollback-packages --pullRequestNumber 88
getPulls(argv, argv.pullRequestNumber).catch(console.error);
// lib.closeIssue(argv).catch(console.error);
