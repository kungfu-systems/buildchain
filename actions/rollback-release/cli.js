/* eslint-disable no-restricted-globals */
import { rollbackRelease } from './lib.js';
import yargs from 'yargs/yargs';

const argv = yargs(process.argv.slice(2))
  .option('token', { description: 'token', type: 'string' })
  .option('owner', { description: 'owner', type: 'string' })
  .option('repo', { description: 'repo', type: 'string' })
  .option('baseRef', { description: 'repo', type: 'string' })
  .option('headRef', { description: 'repo', type: 'string' })
  .help().argv;

rollbackRelease(argv).catch(console.error);
