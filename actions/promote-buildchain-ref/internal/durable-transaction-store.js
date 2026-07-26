import fs from "node:fs";
import path from "node:path";
import { writeReleaseTransaction } from "../../../packages/core/publish-transaction.js";
import {
  decodeGitBlob,
  getGitCommitWithRetry,
  getGitRefOrUndefined,
  githubRetryDelayMs,
  nonFastForwardUpdateRejected,
  referenceAlreadyExists,
  retryGitHubOperation,
  wait,
} from "./github-adapter.js";

function durableTransactionHeadRef(transaction) {
  if (!transaction?.state_ref) {
    throw new Error("release transaction durable state_ref is required");
  }
  return `heads/${transaction.state_ref}`;
}


async function restoreDurableReleaseTransaction({
  octokit,
  owner,
  repo,
  stateRef,
  statePath,
  evidencePath,
}) {
  if (!octokit || !stateRef) {
    return undefined;
  }
  const record = await readDurableReleaseTransaction({
    octokit,
    owner,
    repo,
    stateRef,
  });
  if (!record) {
    return undefined;
  }
  writeReleaseTransaction(statePath, record);

  const ref = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `heads/${stateRef}`,
  });
  const commitSha = ref.object?.sha;
  const { data: commit } = await getGitCommitWithRetry({ octokit, owner, repo, commitSha });
  const { data: tree } = await retryGitHubOperation(
    `git.getTree ${stateRef}`,
    () => octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: commit.tree.sha,
      recursive: "1",
    }),
  );
  const entryByPath = new Map((tree.tree || []).map((entry) => [entry.path, entry]));
  const evidenceEntry = entryByPath.get("evidence.json");
  if (evidenceEntry) {
    const { data: evidenceBlob } = await retryGitHubOperation(
      `git.getBlob ${stateRef}/evidence.json`,
      () => octokit.rest.git.getBlob({
        owner,
        repo,
        file_sha: evidenceEntry.sha,
      }),
    );
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, decodeGitBlob(evidenceBlob));
  }

  return record;
}

async function readDurableReleaseTransaction({
  octokit,
  owner,
  repo,
  stateRef,
}) {
  if (!octokit || !stateRef) {
    return undefined;
  }
  const ref = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `heads/${stateRef}`,
  });
  if (!ref) {
    return undefined;
  }
  const commitSha = ref.object?.sha;
  const { data: commit } = await getGitCommitWithRetry({ octokit, owner, repo, commitSha });
  const { data: tree } = await retryGitHubOperation(
    `git.getTree ${stateRef}`,
    () => octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: commit.tree.sha,
      recursive: "1",
    }),
  );
  const entryByPath = new Map((tree.tree || []).map((entry) => [entry.path, entry]));
  const stateEntry = entryByPath.get("state.json");
  if (!stateEntry) {
    throw new Error(`durable release transaction ${stateRef} is missing state.json`);
  }
  const { data: stateBlob } = await retryGitHubOperation(
    `git.getBlob ${stateRef}/state.json`,
    () => octokit.rest.git.getBlob({
      owner,
      repo,
      file_sha: stateEntry.sha,
    }),
  );
  return JSON.parse(decodeGitBlob(stateBlob));
}

async function persistDurableReleaseTransaction({
  octokit,
  owner,
  repo,
  cwd,
  transaction,
  evidencePath,
  extraFiles = [],
}) {
  if (!octokit || !transaction) {
    return undefined;
  }
  const refName = durableTransactionHeadRef(transaction);
  const currentRef = await getGitRefOrUndefined({ octokit, owner, repo, ref: refName });

  const stateBlob = await retryGitHubOperation(
    `git.createBlob ${transaction.state_ref}/state.json`,
    () => octokit.rest.git.createBlob({
      owner,
      repo,
      content: JSON.stringify(transaction, null, 2) + "\n",
      encoding: "utf-8",
    }),
  );
  const treeEntries = [
    {
      path: "state.json",
      mode: "100644",
      type: "blob",
      sha: stateBlob.data.sha,
    },
  ];
  if (evidencePath && fs.existsSync(evidencePath)) {
    const evidenceBlob = await retryGitHubOperation(
      `git.createBlob ${transaction.state_ref}/evidence.json`,
      () => octokit.rest.git.createBlob({
        owner,
        repo,
        content: fs.readFileSync(evidencePath, "utf8"),
        encoding: "utf-8",
      }),
    );
    treeEntries.push({
      path: "evidence.json",
      mode: "100644",
      type: "blob",
      sha: evidenceBlob.data.sha,
    });
  }
  for (const file of extraFiles) {
    if (!file?.path) {
      continue;
    }
    const blob = await retryGitHubOperation(
      `git.createBlob ${transaction.state_ref}/${file.path}`,
      () => octokit.rest.git.createBlob({
        owner,
        repo,
        content: String(file.content || ""),
        encoding: "utf-8",
      }),
    );
    treeEntries.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.data.sha,
    });
  }

  const createStateCommit = async (parentSha) => {
    let baseTree;
    const parents = [];
    if (parentSha) {
      const { data: currentCommit } = await getGitCommitWithRetry({ octokit, owner, repo, commitSha: parentSha });
      baseTree = currentCommit.tree?.sha;
      parents.push(parentSha);
    }
    const tree = await retryGitHubOperation(
      `git.createTree ${transaction.state_ref}`,
      () => octokit.rest.git.createTree({
        owner,
        repo,
        tree: treeEntries,
        ...(baseTree ? { base_tree: baseTree } : {}),
      }),
    );
    return retryGitHubOperation(
      `git.createCommit ${transaction.state_ref}`,
      () => octokit.rest.git.createCommit({
        owner,
        repo,
        message: `chore(buildchain): persist release transaction ${transaction.exact_tag}`,
        tree: tree.data.sha,
        parents,
      }),
    );
  };
  const readCurrentRefSha = async () => {
    const latestRef = await getGitRefOrUndefined({ octokit, owner, repo, ref: refName });
    return latestRef?.object?.sha || "";
  };
  const readCurrentRefShaAfterNonFastForward = async (previousParentSha) => {
    let currentSha = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      currentSha = await readCurrentRefSha();
      if (currentSha && currentSha !== previousParentSha) {
        return currentSha;
      }
      if (attempt < 3) {
        await wait(githubRetryDelayMs() * (attempt + 1));
      }
    }
    return currentSha;
  };
  const updateExistingRef = async (parentSha) => {
    let latestParentSha = parentSha || "";
    let latestCommit = await createStateCommit(latestParentSha);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await retryGitHubOperation(
          `git.updateRef ${refName}`,
          () => octokit.rest.git.updateRef({
            owner,
            repo,
            ref: refName,
            sha: latestCommit.data.sha,
            force: false,
          }),
        );
        return latestCommit;
      } catch (error) {
        if (!nonFastForwardUpdateRejected(error)) {
          throw error;
        }
        const currentSha = await readCurrentRefSha();
        if (currentSha === latestCommit.data.sha) {
          return latestCommit;
        }
        if (!currentSha || attempt === 2) {
          throw error;
        }
        if (currentSha === latestParentSha) {
          const refreshedSha = await readCurrentRefShaAfterNonFastForward(latestParentSha);
          if (refreshedSha === latestCommit.data.sha) {
            return latestCommit;
          }
          if (!refreshedSha) {
            throw error;
          }
          if (refreshedSha === latestParentSha) {
            continue;
          }
          latestParentSha = refreshedSha;
          latestCommit = await createStateCommit(latestParentSha);
          continue;
        }
        latestParentSha = currentSha;
        latestCommit = await createStateCommit(latestParentSha);
      }
    }
    return latestCommit;
  };

  let commit;
  if (currentRef) {
    commit = await updateExistingRef(currentRef.object?.sha);
  } else {
    commit = await createStateCommit();
    try {
      await retryGitHubOperation(
        `git.createRef ${refName}`,
        () => octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/${refName}`,
          sha: commit.data.sha,
        }),
      );
    } catch (error) {
      if (!referenceAlreadyExists(error)) {
        throw error;
      }
      const currentSha = await readCurrentRefSha();
      if (currentSha === commit.data.sha) {
        return {
          ref: transaction.state_ref,
          sha: commit.data.sha,
          statePath: path.relative(cwd, transaction.state_path || "").split(path.sep).join("/"),
        };
      }
      commit = await updateExistingRef(currentSha);
    }
  }
  return {
    ref: transaction.state_ref,
    sha: commit.data.sha,
    statePath: path.relative(cwd, transaction.state_path || "").split(path.sep).join("/"),
  };
}


export {
  persistDurableReleaseTransaction,
  readDurableReleaseTransaction,
  restoreDurableReleaseTransaction,
};
