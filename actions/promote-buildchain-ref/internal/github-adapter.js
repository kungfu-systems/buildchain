import { sha256Content } from "./version-state.js";

function notFound(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return (
    status === 404 ||
    (status === 422 && /Reference does not exist/i.test(message))
  );
}

function referenceAlreadyExists(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return status === 422 && /Reference already exists/i.test(message);
}

function nonFastForwardUpdateRejected(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return status === 422 && /Update is not a fast forward/i.test(message);
}

function decodeGitBlobBuffer(blob) {
  const content = blob?.content || "";
  return Buffer.from(
    content.replace(/\n/g, ""),
    blob?.encoding === "base64" ? "base64" : "utf8",
  );
}

function decodeGitBlob(blob) {
  return decodeGitBlobBuffer(blob).toString("utf8");
}

function transientGitHubReadError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const code = String(error?.code || error?.cause?.code || "");
  const message = String(error?.message || "");
  return (
    status >= 500 ||
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ].includes(code) ||
    /other side closed|socket|timeout|temporarily unavailable/i.test(message)
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function githubRetryDelayMs() {
  const raw = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  if (raw === undefined || raw === "") {
    return 1000;
  }
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1000;
}

async function retryGitHubOperation(
  label,
  operation,
  { attempts = 4, delayMs = githubRetryDelayMs() } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !transientGitHubReadError(error)) {
        throw error;
      }
      console.warn(
        `${label} failed with transient GitHub API error (${error.message}); retry ${attempt}/${attempts - 1}`,
      );
      await wait(delayMs * attempt);
    }
  }
  throw lastError;
}

async function getGitRefOrUndefined({ octokit, owner, repo, ref }) {
  try {
    const { data } = await retryGitHubOperation(
      `git.getRef ${ref}`,
      () => octokit.rest.git.getRef({ owner, repo, ref }),
    );
    return data;
  } catch (error) {
    if (notFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function getGitCommitWithRetry({ octokit, owner, repo, commitSha }) {
  return retryGitHubOperation(`git.getCommit ${commitSha}`, () =>
    octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: commitSha,
    }),
  );
}

async function collectRemoteVersionMaterial({
  octokit,
  owner,
  repo,
  commitSha,
  paths,
}) {
  const commit = await getGitCommitWithRetry({
    octokit,
    owner,
    repo,
    commitSha,
  });
  const tree = await retryGitHubOperation(
    `git.getTree ${commitSha} recursive`,
    () =>
      octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: commit.data.tree.sha,
        recursive: "1",
      }),
  );
  const entries = new Map(
    (tree.data.tree || [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry]),
  );
  return Promise.all(
    paths.map(async (filePath) => {
      const entry = entries.get(filePath);
      if (!entry) {
        return {
          path: filePath,
          present: false,
          bytes: 0,
          sha256: "",
        };
      }
      const blob = await retryGitHubOperation(
        `git.getBlob ${commitSha}:${filePath}`,
        () =>
          octokit.rest.git.getBlob({
            owner,
            repo,
            file_sha: entry.sha,
          }),
      );
      const content =
        blob.data.encoding === "base64"
          ? Buffer.from(
              String(blob.data.content || "").replace(/\s/g, ""),
              "base64",
            )
          : Buffer.from(String(blob.data.content || ""), "utf8");
      return {
        path: filePath,
        present: true,
        bytes: content.length,
        sha256: sha256Content(content),
      };
    }),
  );
}

async function remoteVersionStateFilesMatch({
  octokit,
  owner,
  repo,
  currentSha,
  generatedSha,
  paths,
}) {
  if (
    !currentSha ||
    !generatedSha ||
    !paths?.length ||
    typeof octokit.rest.git.getBlob !== "function"
  ) {
    return false;
  }
  let current;
  let generated;
  try {
    [current, generated] = await Promise.all([
      collectRemoteVersionMaterial({ octokit, owner, repo, commitSha: currentSha, paths }),
      collectRemoteVersionMaterial({ octokit, owner, repo, commitSha: generatedSha, paths }),
    ]);
  } catch (error) {
    if (
      error?.status === 404 ||
      error?.response?.status === 404 ||
      error?.response?.data?.message === "Reference does not exist"
    ) {
      return false;
    }
    throw error;
  }
  return current.every((entry, index) => {
    const expected = generated[index];
    return (
      entry.path === expected?.path &&
      entry.present === true &&
      expected.present === true &&
      entry.bytes === expected.bytes &&
      entry.sha256 === expected.sha256
    );
  });
}

async function collectPromotionVersionMaterial(
  context,
  releaseCommit,
  releaseSha,
  sourceAlphaMaterial,
) {
  if (
    !(releaseCommit.derivedVersionMaterial?.length > 0) ||
    !sourceAlphaMaterial?.sha
  ) {
    return undefined;
  }
  const allowedPaths = releaseCommit.releaseTreeAllowedPaths || releaseCommit.files;
  const [alphaCommit, releaseCommitInfo, alphaMaterial, releaseMaterial] =
    await Promise.all([
      context.getCommitInfo(context.octokit, context.owner, context.repo, sourceAlphaMaterial.sha),
      context.getCommitInfo(context.octokit, context.owner, context.repo, releaseSha),
      collectRemoteVersionMaterial({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        commitSha: sourceAlphaMaterial.sha,
        paths: allowedPaths,
      }),
      collectRemoteVersionMaterial({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        commitSha: releaseSha,
        paths: allowedPaths,
      }),
    ]);
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-anchored-version-material/v1",
    strategy: releaseCommit.versionStrategy,
    alpha: {
      ref: sourceAlphaMaterial.tag,
      commit: sourceAlphaMaterial.sha,
      tree: alphaCommit.treeSha,
      material: alphaMaterial,
    },
    release: {
      ref: context.targetRef,
      commit: releaseSha,
      tree: releaseCommitInfo.treeSha,
      material: releaseMaterial,
    },
    allowedPaths,
    versionFiles: releaseCommit.files,
    manifest: releaseCommit.anchorManifest?.path || "",
    derivedPaths: releaseCommit.derivedVersionMaterial.map((file) => file.path),
    derivedFiles: releaseCommit.derivedVersionMaterial,
  };
}

async function listPullRequestsAssociatedWithCommitWithRetry({
  octokit,
  owner,
  repo,
  commitSha,
}) {
  return retryGitHubOperation(
    `repos.listPullRequestsAssociatedWithCommit ${commitSha}`,
    () =>
      octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: commitSha,
      }),
  );
}

export {
  collectPromotionVersionMaterial,
  collectRemoteVersionMaterial,
  remoteVersionStateFilesMatch,
  decodeGitBlob,
  decodeGitBlobBuffer,
  getGitCommitWithRetry,
  getGitRefOrUndefined,
  githubRetryDelayMs,
  listPullRequestsAssociatedWithCommitWithRetry,
  nonFastForwardUpdateRejected,
  notFound,
  referenceAlreadyExists,
  retryGitHubOperation,
  wait,
};
