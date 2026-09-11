import path from "node:path";
import { githubJson } from "./../candidate/transport.js";
import { releaseTransactionStateRef } from "../publish-transaction.js";
export async function readTransactionAtRef({
  repoInfo,
  apiUrl,
  token,
  fetchImpl,
  stateRef,
}) {
  const response = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    allowNotFound: true,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/contents/state.json?ref=${encodeURIComponent(stateRef)}`,
  });
  if (!response) return undefined;
  if (
    response.type !== "file" ||
    response.encoding !== "base64" ||
    !response.content
  ) {
    throw new Error(
      `durable transaction ${stateRef} did not expose a base64 state.json file`,
    );
  }
  return JSON.parse(
    Buffer.from(String(response.content).replace(/\s/g, ""), "base64").toString(
      "utf8",
    ),
  );
}

export async function readExistingTransaction({
  repoInfo,
  apiUrl,
  token,
  fetchImpl,
  version,
}) {
  return readTransactionAtRef({
    repoInfo,
    apiUrl,
    token,
    fetchImpl,
    stateRef: releaseTransactionStateRef(version),
  });
}

export async function readExistingTransactionById({
  repoInfo,
  apiUrl,
  token,
  fetchImpl,
  transactionId,
}) {
  if (!transactionId) return undefined;
  const statePrefix = "buildchain/release-state/";
  const refs = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/git/matching-refs/heads/${statePrefix}`,
  });
  for (const ref of refs) {
    const transaction = await readTransactionAtRef({
      repoInfo,
      apiUrl,
      token,
      fetchImpl,
      stateRef: String(ref.ref).replace(/^refs\/heads\//, ""),
    });
    if (transaction?.id === transactionId) return transaction;
  }
  throw new Error(
    `durable publication transaction ${transactionId} was not found`,
  );
}

export async function resolveTargetAdvance({
  observedTargetSha,
  targetSha,
  transactionId,
  existingTransaction,
  repoInfo,
  apiUrl,
  token,
  fetchImpl,
}) {
  if (
    observedTargetSha === targetSha ||
    !transactionId ||
    existingTransaction?.id !== transactionId
  )
    return undefined;
  const comparison = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/compare/${targetSha}...${observedTargetSha}`,
  });
  return {
    status: comparison.status,
    mergeIsAncestor: ["ahead", "identical"].includes(comparison.status),
  };
}

export async function resolveRecoveryTransaction({
  repoInfo,
  apiUrl,
  token,
  fetchImpl,
  transactionId,
  publicationVersion,
}) {
  let transaction =
    transactionId && publicationVersion
      ? await readExistingTransaction({
          repoInfo,
          apiUrl,
          token,
          fetchImpl,
          version: publicationVersion,
        })
      : undefined;
  if (transactionId && transaction?.id !== transactionId) {
    transaction = transactionId
      ? await readExistingTransactionById({
          repoInfo,
          apiUrl,
          token,
          fetchImpl,
          transactionId,
        })
      : undefined;
  }
  return { version: transaction?.version || publicationVersion, transaction };
}
