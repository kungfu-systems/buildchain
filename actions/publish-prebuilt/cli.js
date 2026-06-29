/* eslint-disable no-restricted-globals */
const lib = require('./lib.js');

const argv = require('yargs/yargs')(process.argv.slice(2))
  .option('token', { description: 'token', type: 'string' })
  .option('owner', { description: 'owner', type: 'string' })
  .option('repo', { description: 'repo', type: 'string' })
  .option('artifacts-path', { description: 'artifacts path', type: 'string' })
  .option('bucket-staging', { description: 'S3 bucket for staging', type: 'string', demandOption: true })
  .option('bucket-release', { description: 'S3 bucket for release', type: 'string' })
  .option('aws-proxy', { description: 'AWS proxy in /etc/hosts', type: 'string' })
  .option('pull-request-number', { description: 'Pull Request number', type: 'number' })
  .option('no-digest', { description: 'Do not digest files', type: 'boolean', default: true })
  .option('no-comment', { description: 'Do not add comment to GitHub', type: 'boolean', default: true })
  .help().argv;

if (argv.awsProxy) {
  lib.setupProxy(argv.awsProxy);
}

if (argv.artifactsPath && argv.bucketStaging) {
  lib.clean(argv.repo, argv.bucketStaging);
  if (!argv.noDigest) {
    lib.digest(argv.repo, argv.artifactsPath);
  }
  lib.stage(argv.repo, argv.artifactsPath, argv.bucketStaging);
  if (!argv.noComment) {
    lib
      .addPreviewComment(
        argv.token,
        argv.owner,
        argv.repo,
        argv.pullRequestNumber,
        argv.bucketStaging,
        argv.bucketRelease,
      )
      .catch(console.error);
  }
}

if (argv.bucketStaging && argv.bucketRelease) {
  lib.publish(argv.repo, argv.bucketStaging, argv.bucketRelease);
  lib.clean(argv.repo, argv.bucketStaging);
  lib.deletePreviewComment(argv.token, argv.owner, argv.repo, argv.pullRequestNumber).catch(console.error);
}
