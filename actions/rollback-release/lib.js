/* eslint-disable no-restricted-globals */
const github = require('@actions/github');
const fse = require('fs-extra');
const path = require('path');
const git = require('git-client');
const semver = require('semver');
const { spawnSync } = require('child_process');

const spawnOpts = { shell: true, stdio: 'pipe', windowsHide: true };

async function gitCall(...args) {
  console.log('$ git', ...args);
  const output = await git(...args);
  console.log(output);
  return output;
}

exports.rollbackRelease = async function (argv) {
  const rootPackageJson = fse.readJSONSync('package.json');
  console.log(`token:${argv.token}`);
  console.log(rootPackageJson);
  try {
    await exports.solveAllPackages(argv);
  } catch (err) {
    console.log(err);
  }
};

exports.solveAllPackages = async function (argv) {
  const pkgsWorkspace = spawnSync('yarn', ['-s', 'workspaces', 'info'], spawnOpts);
  const outputStr = pkgsWorkspace.output.filter((e) => e && e.length > 0).toString();
  const output = JSON.parse(outputStr);

  for (const key in output) {
    console.log(`package path is: ${output[key].location}`);
    const processPath = process.cwd();
    console.log(`process path is: ${processPath}`);
    const packagePath = path.join(processPath, output[key].location);
    const npm_package = path.join(packagePath, 'package.json');
    // const package = path.join(processCwd, output[key].location, 'package.json');
    console.log(`Package.json path is: ${npm_package}`);
    const config = JSON.parse(fse.readFileSync(npm_package));
    const info = {
      names: config.name.split(['/'])[1],
      delVersion: config.version,
      npm_package: npm_package,
      config: config,
    };

    if (`${config.private}` === true) {
      console.log(`Package set {'Private': true} will not be published, just skipping!`);
    } else {
      console.log(`--- Starting to delete package: ${info.names}(version:${info.delVersion}) ---`);
      try {
        await exports.deletePublishedPackages(argv, info);
      } catch (e) {
        console.log('[Warning!] Error on delete published package:\n', e);
      }
    }
  }
  await exports.createNewPullRequest(output, argv);
};

function hasLerna(cwd) {
  return fse.existsSync(path.join(cwd, 'lerna.json'));
}

function getCurrentVersion(cwd) {
  const configPath = path.join(cwd, hasLerna(cwd) ? 'lerna.json' : 'package.json');
  const config = JSON.parse(fse.readFileSync(configPath));
  return semver.parse(config.version);
}

exports.createNewPullRequest = async function (output, argv) {
  const currentVersion = getCurrentVersion(process.cwd());
  const versionRef = `v${currentVersion.major}/v${currentVersion.major}.${currentVersion.minor}`;
  const devChannel = `dev/${versionRef}`;
  await gitCall('fetch');
  //await gitCall('switch', devChannel, `origin/${devChannel}`); //`origin/${devChannel}`
  await gitCall('switch', devChannel);
  await gitCall('pull');

  const octokit = github.getOctokit(argv.token);
  const lastMergedPullRequestInfo = await octokit.graphql(`
    query {
      repository(name: "${argv.repo}", owner: "${argv.owner}") {
        id
        url
        pullRequests(last: 1, states: MERGED) {
          nodes {
            id
            state
            number
            title
          }
        }
      }
    }`);
  const number = lastMergedPullRequestInfo.repository.pullRequests.nodes[0].number;
  const url = lastMergedPullRequestInfo.repository.url;
  const id = lastMergedPullRequestInfo.repository.id;
  const title = lastMergedPullRequestInfo.repository.pullRequests.nodes[0].title;
  const headId = await gitCall('rev-parse', 'HEAD');
  const repositoryNameWithOwner = argv.owner + '/' + argv.repo;
  console.log(`---------The branch now is pointing to ${headId}`);
  console.log(`---------RepositoryNameWithOwner: ${repositoryNameWithOwner}`);
  for (const key in output) {
    console.log(`\npackage path is: ${output[key].location}`);
    const processPath = process.cwd();
    console.log(`process path is: ${processPath}\n`);
    const packagePath = path.join(processPath, output[key].location);
    const npm_package = path.join(packagePath, 'package.json');
    //const package = path.join(processCwd, output[key].location, 'package.json');
    const config = JSON.parse(fse.readFileSync(npm_package));
    const info = {
      names: config.name.split(['/'])[1],
      delVersion: config.version,
      npm_package: npm_package,
      config: config,
    };
    if (!config.repository) {
      config.repository = {
        url: `${url}.git`,
      };
      //fse.writeFileSync(info.package, JSON.stringify(info.config, null, '\t'));
      fse.writeFileSync(info.npm_package, JSON.stringify(info.config, null, 2));
    }
  }
  await gitCall('add', '.');
  await gitCall('commit', '-m', 'creat new pr');
  //await gitCall('push');
  await gitCall('push', 'origin', `HEAD:${devChannel}`);
  //await gitCall('switch', argv.baseRef);
  console.log(`---Merged pr [${title}](pr number:[${number}]) failed. Creating a new open PR...`);
  console.log(`repo id:[${id}]`);
  console.log(`baseRef:[${argv.baseRef}]`);
  console.log(`headRef:[${argv.headRef}]`);
  console.log(`New pr title:[${title}]`);
  const newPullRequest = await octokit.graphql(`
    mutation {
      createPullRequest(input: {repositoryId: "${id}", baseRefName: "${argv.baseRef}", headRefName: "${argv.headRef}", title: "${title}"}) {
        clientMutationId
      }
    }`);
  console.log(`New pr has created, which is:[${title}](${argv.headRef}--->${argv.baseRef});`);
};

exports.deletePublishedPackage = async function (argv, info) {
  const octokit = github.getOctokit(argv.token);
  const number = 1;
  const packageInfo = await octokit.graphql(`
    query {
      repository(name: "${argv.repo}", owner: "${argv.owner}") {
        packages(names: "${info.names}", first: ${number}) {
          edges {
            node {
              name
              versions(first:${number}) {
                edges {
                  node {
                    id
                    version
                  }
                }
              }
            }
          }
        }
      }
    }`);
  const edgesNumber = 0;
  const packageVersionId = packageInfo.repository.packages.edges[edgesNumber].node.versions.edges[edgesNumber].node.id;
  const packageVersion =
    packageInfo.repository.packages.edges[edgesNumber].node.versions.edges[edgesNumber].node.version;
  console.log(`| Version [${info.delVersion}] needs to be deleted |`);
  console.log(`| Version [${packageVersion}] has found |`);
  if (info.delVersion == packageVersion) {
    const deletePkg = await octokit.graphql(
      `
      mutation {
        deletePackageVersion(input: {packageVersionId: "${packageVersionId}"}) {
          success
        }
      }`,
      { headers: { accept: `application/vnd.github.package-deletes-preview+json` } },
    );
    console.log(`[Sucess!] Already has deleted package [${info.names}] with version [${info.delVersion}] \n`);
  } else {
    console.log(
      `[Notice!] Package [${info.names}] with version [${info.delVersion}] didn't be published, earlier version [${packageVersion}] exists now.\n\n`,
    );
  }
};

exports.deletePublishedPackages = async function (argv, info) {
  const octokit = github.getOctokit(argv.token);
  const res = await octokit.rest.packages.getAllPackageVersionsForPackageOwnedByOrg({
    package_type: 'npm',
    package_name: info.names,
    org: 'kungfu-trader',
  });
  packageVersion = res.data[0].name;
  console.log(`| Version [${info.delVersion}] needs to be deleted |`);
  console.log(`| Version [${packageVersion}] has found |`);

  if (info.delVersion == packageVersion) {
    const delete_pkg = await octokit.rest.packages.deletePackageVersionForOrg({
      package_type: 'npm',
      package_name: info.names,
      org: 'kungfu-trader',
      package_version_id: res.data[0].id,
    });
    console.log(`[Sucess!] Already has deleted package [${info.names}] with version [${info.delVersion}] \n`);
  } else {
    console.log(
      `[Notice!] Package [${info.names}] with version [${info.delVersion}] didn't be published, earlier version [${packageVersion}] exists now.\n\n`,
    );
  }
};
