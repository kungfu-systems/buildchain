/* eslint-disable no-restricted-globals */
const { boolean } = require('yargs');
const lib = require('./lib.js');

const argv = require('yargs/yargs')(process.argv.slice(2))
  .option('token', { description: 'token', type: 'string' })
  .option('owner', { description: 'owner', type: 'string' })
  .option('repo', { description: 'repo', type: 'string' })
  .option('baseRef', { description: 'repo', type: 'string' })
  .option('headRef', { description: 'repo', type: 'string' })
  .help().argv;

lib.rollbackRelease(argv).catch(console.error);
