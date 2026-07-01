/* eslint-disable no-restricted-globals */
import { checkFormat } from './lib.js';
import yargs from 'yargs/yargs';

const argv = yargs(process.argv.slice(2))
  .option('token', { description: 'token', type: 'string' })
  .option('owner', { description: 'owner', type: 'string' })
  .option('repo', { description: 'repo', type: 'string' })
  .option('pullRequestNumber', { description: 'pullRequestNumber', type: 'number' })
  .help().argv;

//const owner = 'kungfu-trader';
//const repo = 'action-check-format';
//const pullRequestNumber = 6;
//const token = core.getInput('token');
//const token = '<GITHUB_TOKEN>';

checkFormat(argv).catch(console.error);
