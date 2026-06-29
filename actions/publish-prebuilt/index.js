/* eslint-disable no-restricted-globals */
const lib = (exports.lib = require('./lib.js'));
const core = require('@actions/core');
const github = require('@actions/github');

const main = async function () {
  const context = github.context;
  const token = core.getInput('token');
  const awsProxy = core.getInput('aws-proxy');
  const artifactsPath = core.getInput('artifacts-path');
  const bucketStaging = core.getInput('bucket-staging');
  const bucketRelease = core.getInput('bucket-release');
  const cleanRelease = core.getInput('clean-release') !== 'false';
  const cloudfrontId = core.getInput('cloudfront-id');
  const cloudfrontPaths = core.getInput('cloudfront-paths');
  const withDigest = core.getInput('no-digest') === 'false';
  const withComment = core.getInput('no-comment') === 'false';
  const previewOpts = {
    match: core.getInput('preview-files'),
    limit: parseInt(core.getInput('max-preview-links'), 10) || 1,
  };
  const repo = github.context.repo;
  const pullRequestNumber = () => (context.issue.number ? context.issue.number : context.payload.pull_request.number);

  if (awsProxy) {
    lib.setupProxy(awsProxy);
  }

  const addComment = async (opts = {}) => {
    if (withComment) {
      await lib
        .addPreviewComment(token, repo.owner, repo.repo, pullRequestNumber(), bucketStaging, bucketRelease, {
          ...previewOpts,
          ...opts,
        })
        .catch(console.error);
    }
  };

  const deleteComment = async () => {
    if (withComment) {
      await lib.deletePreviewComment(token, repo.owner, repo.repo, pullRequestNumber()).catch(console.error);
    }
  };

  if (artifactsPath && bucketStaging) {
    await deleteComment();
    lib.clean(repo.repo, bucketStaging);
    if (withDigest) {
      lib.digest(repo.repo, artifactsPath);
    }
    lib.stage(repo.repo, artifactsPath, bucketStaging);
    await addComment();
  }

  if (bucketStaging && bucketRelease) {
    lib.publish(repo.repo, bucketStaging, bucketRelease, cleanRelease);
    lib.refreshCloudfront(cloudfrontId, cloudfrontPaths);
    await deleteComment();
    await addComment({ release: true, bucketRelease: bucketRelease });
    lib.clean(repo.repo, bucketStaging);
  }

  if (artifactsPath && bucketRelease) {
    lib.release(repo.repo, artifactsPath, bucketRelease, cleanRelease);
    lib.refreshCloudfront(cloudfrontId, cloudfrontPaths);
  }
};

if (process.env.GITHUB_ACTION) {
  main().catch((error) => {
    console.error(error);
    core.setFailed(error.message);
  });
}
