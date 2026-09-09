import {
  compareDevelopmentVersions,
  createStableDevelopmentTransition,
} from "../../publication/publication-development.js";
import { prepareDevelopmentSource } from "./development-source.js";
import {
  discoverConfiguredDerivedVersionMaterial,
  getVersionStrategy,
} from "../../consumer/buildchain-config.js";
import {
  createNextDevelopmentTransition,
  nextDevelopmentRoot,
} from "../next-development-transition.js";
import { discoverVersionStateFiles } from "../version-state.js";
import { assertNextDevelopmentPull } from "./next-development-queue.js";
import { commitContainsReleaseState } from "./product-provider-github-adapters.js";
import {
  enqueueNextDevelopmentPullRequest,
  localVersionFiles,
} from "./product-provider-adapters.js";

const NEXT_DEVELOPMENT_POLL_MS = 15_000;
const NEXT_DEVELOPMENT_MAX_POLLS = 480;
const NEXT_DEVELOPMENT_SIGN_OFF =
  "Signed-off-by: Keren Dong <keren.dong@kungfu.link>";

function repositoryParts(repository) {
  const [owner, repo] = String(repository || "").split("/");
  if (!owner || !repo) throw new Error(`invalid repository: ${repository}`);
  return { owner, repo };
}

async function readRef(octokit, repository, ref) {
  const { owner, repo } = repositoryParts(repository);
  try {
    return (
      await octokit.rest.git.getRef({
        owner,
        repo,
        ref: ref.replace(/^refs\//u, ""),
      })
    ).data.object.sha;
  } catch (error) {
    if (Number(error?.status || error?.response?.status) === 404) return "";
    throw error;
  }
}

async function remotePackageVersion(octokit, repository, ref) {
  const { owner, repo } = repositoryParts(repository);
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: "package.json",
    ref,
  });
  return JSON.parse(Buffer.from(data.content, data.encoding).toString())
    .version;
}

async function prepareNextDevelopment({
  cwd,
  completedStable,
  completedAlpha,
  completed,
  prepareSource,
  devSha,
  devVersion,
  octokit,
  repository,
}) {
  const snapshot = completedStable
    ? prepareSource({ cwd, sourceSha: devSha })
    : { cwd, dispose() {} };
  let transition, versionFiles;
  const { owner, repo } = repositoryParts(repository);
  let devCommit;
  try {
    devCommit = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: devSha,
    });
    const discovered = discoverVersionStateFiles(snapshot.cwd);
    const sourcePaths = discovered.files.map(({ path }) => path).sort();
    const derivedPaths = discoverConfiguredDerivedVersionMaterial(
      snapshot.cwd,
      discovered.config,
    ).map(({ path }) => path);
    const input = {
      repository,
      model: getVersionStrategy(discovered.config),
      sourcePaths,
      derivedPaths,
    };
    transition = completedStable
      ? createStableDevelopmentTransition({ ...input, completedStable })
      : createNextDevelopmentTransition({ ...input, completedAlpha });
    if (transition.state.status === "waiting-anchor")
      return { status: "waiting-anchor", transition };
    const order = compareDevelopmentVersions(
      devVersion,
      transition.target.version,
    );
    if (order >= 0)
      return {
        status: order === 0 ? "already-current" : "already-advanced",
        transition,
        devSha,
      };
    if (
      completedStable &&
      devVersion.split("-alpha.")[0] !== completedStable.version
    )
      throw new Error("protected Dev is outside the completed stable patch");
    if (!completedStable && devCommit.data.tree.sha !== completedAlpha.treeSha)
      throw new Error(
        "protected Dev tree drifted before next-version materialization",
      );
    versionFiles = localVersionFiles(snapshot.cwd, {
      channel: "alpha",
      version: transition.target.version,
      sourceSha: devSha,
      sourceTimestamp: completed.completedAt,
    });
  } finally {
    snapshot.dispose();
  }
  return { transition, versionFiles, devCommit };
}

async function advanceNextDevelopment({
  cwd = process.cwd(),
  repository,
  completedAlpha,
  completedStable,
  prepareSource = prepareDevelopmentSource,
  octokit,
  mutationOctokit,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  pollIntervalMs = NEXT_DEVELOPMENT_POLL_MS,
  maxPolls = NEXT_DEVELOPMENT_MAX_POLLS,
}) {
  const completed = completedStable || completedAlpha;
  const match = String(completed?.version || "").match(/^(\d+)\.(\d+)\./u);
  if (!match) throw new Error("completed publication version is invalid");
  const devBranch = `dev/v${match[1]}/v${match[1]}.${match[2]}`;
  const devSha = await readRef(octokit, repository, `refs/heads/${devBranch}`);
  if (!devSha) throw new Error(`protected Dev branch ${devBranch} is absent`);
  const devVersion = await remotePackageVersion(octokit, repository, devSha);
  const prepared = await prepareNextDevelopment({
    cwd,
    completedStable,
    completedAlpha,
    completed,
    prepareSource,
    devSha,
    devVersion,
    octokit,
    repository,
  });
  if (prepared.status) return prepared;
  const { transition, versionFiles, devCommit } = prepared;
  const { owner, repo } = repositoryParts(repository);
  const preparationKey = completedStable
    ? nextDevelopmentRoot({ transition: transition.idempotencyKey, devSha })
    : transition.idempotencyKey;
  const suffix = preparationKey.replace(/^sha256:/u, "").slice(0, 16);
  const head = `chore/next-development/${transition.target.version}-${suffix}`;
  let headSha = await readRef(octokit, repository, `refs/heads/${head}`);
  if (!headSha) {
    if (
      (await readRef(octokit, repository, `refs/heads/${devBranch}`)) !== devSha
    )
      throw new Error("protected Dev moved before next-version write");
    const tree = [];
    for (const file of versionFiles) {
      const blob = await mutationOctokit.rest.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: "utf-8",
      });
      tree.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      });
    }
    const preparedTree = await mutationOctokit.rest.git.createTree({
      owner,
      repo,
      base_tree: devCommit.data.tree.sha,
      tree,
    });
    const commit = await mutationOctokit.rest.git.createCommit({
      owner,
      repo,
      message:
        `chore(release): prepare ${transition.target.version}\n\n` +
        NEXT_DEVELOPMENT_SIGN_OFF,
      tree: preparedTree.data.sha,
      parents: [devSha],
    });
    headSha = commit.data.sha;
    await mutationOctokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${head}`,
      sha: headSha,
    });
  }

  const listed = await mutationOctokit.rest.pulls.list({
    owner,
    repo,
    state: "all",
    base: devBranch,
    head: `${owner}:${head}`,
  });
  if (listed.data.length > 1)
    throw new Error("ambiguous next-development pull requests");
  let pull = listed.data[0];
  if (!pull)
    pull = (
      await mutationOctokit.rest.pulls.create({
        owner,
        repo,
        head,
        base: devBranch,
        title: `Prepare ${transition.target.version}`,
        body: `Advance protected development to ${transition.target.version} after completed ${completedStable ? "stable" : "alpha"} publication ${completed.exactTag}.`,
      })
    ).data;
  assertNextDevelopmentPull(pull, headSha, devBranch);
  if (!pull.merged_at)
    await enqueueNextDevelopmentPullRequest({
      mutationOctokit,
      pull,
      headSha,
      wait,
    });
  for (let poll = 0; !pull.merged_at && poll <= maxPolls; poll += 1) {
    if (poll > 0) await wait(pollIntervalMs);
    pull = (
      await octokit.rest.pulls.get({ owner, repo, pull_number: pull.number })
    ).data;
  }
  assertNextDevelopmentPull(pull, headSha, devBranch);
  if (!pull.merged_at)
    throw new Error("next-development merge queue timed out");
  const mergedDevSha = await readRef(
    octokit,
    repository,
    `refs/heads/${devBranch}`,
  );
  if (
    !(await commitContainsReleaseState(
      octokit,
      repository,
      headSha,
      mergedDevSha,
    )) ||
    compareDevelopmentVersions(
      await remotePackageVersion(octokit, repository, mergedDevSha),
      transition.target.version,
    ) < 0
  )
    throw new Error("next-development protected Dev readback failed");
  return {
    status: "verified",
    transition,
    devSha: mergedDevSha,
    pullRequest: { number: pull.number, url: pull.html_url },
  };
}

export async function advanceAlphaNextDevelopment(options) {
  const cwd = options.cwd || process.cwd();
  const discovered = discoverVersionStateFiles(cwd);
  const model = getVersionStrategy(discovered.config);
  if (model.strategy === "anchored") {
    const transition = createNextDevelopmentTransition({
      repository: options.repository,
      completedAlpha: options.completedAlpha,
      model,
      sourcePaths: discovered.files.map(({ path }) => path).sort(),
      derivedPaths: discoverConfiguredDerivedVersionMaterial(
        cwd,
        discovered.config,
      ).map(({ path }) => path),
    });
    return { status: "waiting-anchor", transition };
  }
  return advanceNextDevelopment(options);
}
export function advanceStableNextDevelopment(options) {
  return advanceNextDevelopment(options);
}
