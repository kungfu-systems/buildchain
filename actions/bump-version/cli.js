import yargs from 'yargs/yargs';
import * as lib from './lib.js';

const keywords = ['auto', 'patch', 'premajor', 'preminor', 'prerelease', 'verify'];

const argv = yargs(process.argv.slice(2))
  .option('cwd', { type: 'string', default: process.cwd() })
  .option('token', { type: 'string', demandOption: true })
  .option('base-ref', { type: 'string', demandOption: true })
  .option('head-ref', { type: 'string', demandOption: true })
  .option('commit-id', { type: 'string' })
  .option('owner', { type: 'string', default: 'kungfu-systems' })
  .option('repo', { type: 'string', default: 'action-bump-version' })
  .option('protection', { type: 'boolean', default: true })
  .option('publish', { type: 'boolean', default: true })
  .option('protect-dev-branches', { type: 'boolean', default: false })
  .option('dry', { type: 'boolean' })
  .command(
    'bump <keyword>',
    'bump',
    (yargs) => {
      yargs.positional('keyword', {
        description: 'Increment version(s) by semver keyword',
        type: 'string',
        choices: keywords,
        demandOption: true,
      });
    },
    (argv) => {
      lib.setOpts(argv);
      lib.tryBump(argv);
    },
  )
  .command(
    'merge <keyword>',
    'merge',
    (yargs) => {
      yargs.positional('keyword', {
        description: 'Merge downstreamp channels',
        type: 'string',
        choices: keywords,
        demandOption: true,
      });
    },
    (argv) => {
      lib.setOpts(argv);
      lib.tryMerge(argv).catch(console.error);
    },
  )
  .command(
    'verify',
    'verify',
    () => {},
    (argv) => {
      lib.setOpts(argv);
      lib.verify(argv).catch(console.error);
    },
  )
  .command(
    'ensure-protect',
    'ensure branches protection',
    () => {},
    (argv) => {
      lib.setOpts(argv);
      lib.ensureBranchesProtection(argv).catch(console.error);
    },
  )
  .command(
    'suspend-protect',
    'suspend branches protection',
    () => {},
    (argv) => {
      lib.setOpts(argv);
      lib.suspendBranchesProtection(argv).catch(console.error);
    },
  )
  .demandCommand()
  .help().argv;

export { argv };
