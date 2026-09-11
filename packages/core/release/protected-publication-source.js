import { domainContentRoot } from "../contracts/canonical-contracts.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function exactSha(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (SHA_PATTERN.test(normalized)) return normalized;
  throw new Error(`${label} must be an exact Git SHA`);
}

function exactParents(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an ordered Git parent list`);
  }
  return value.map((entry, index) => exactSha(entry, `${label}[${index}]`));
}

export function bindProtectedPublicationSource({
  repository,
  protectedCommit,
  candidateCommit,
  pullRequest,
} = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(String(repository || ""))) {
    throw new Error("protected publication source requires owner/repository");
  }
  const [protectedSource, candidateSource] = [
    ["protected", protectedCommit],
    ["candidate", candidateCommit],
  ].map(([kind, commit]) => ({
    sha: exactSha(commit?.sha, `${kind} source SHA`),
    tree: exactSha(commit?.tree, `${kind} source tree`),
    parents: exactParents(commit?.parents, `${kind} source parents`),
  }));
  if (protectedSource.tree !== candidateSource.tree) {
    throw new Error(
      "protected publication source tree does not match the qualified candidate tree",
    );
  }

  let mode = "exact-commit";
  let pullRequestNumber = null;
  if (protectedSource.sha !== candidateSource.sha) {
    const sameParents =
      protectedSource.parents.join(",") === candidateSource.parents.join(",");
    const squashParents =
      protectedSource.parents.length === 1 &&
      candidateSource.parents.length === 2 &&
      protectedSource.parents[0] === candidateSource.parents[0];
    if (!sameParents && !squashParents) {
      throw new Error(
        "protected publication source is not parent-equivalent to the qualified merge candidate",
      );
    }
    pullRequestNumber = Number(pullRequest?.number || 0);
    const pullRequestHead = exactSha(
      pullRequest?.headSha,
      "publication pull request head SHA",
    );
    const pullRequestMerge = exactSha(
      pullRequest?.mergeSha,
      "publication pull request merge SHA",
    );
    if (
      !Number.isSafeInteger(pullRequestNumber) ||
      pullRequestNumber <= 0 ||
      pullRequest?.merged !== true ||
      pullRequestMerge !== protectedSource.sha ||
      !candidateSource.parents.includes(pullRequestHead) ||
      (squashParents && candidateSource.parents[1] !== pullRequestHead)
    ) {
      throw new Error(
        "protected publication source does not match the merged pull request and qualified merge candidate",
      );
    }
    mode = sameParents ? "merge-equivalent" : "squash-equivalent";
  }

  const binding = {
    schema: "kungfu.buildchain.v4-protected-publication-source/v1",
    repository,
    mode,
    protectedSource,
    candidateSource,
    pullRequestNumber,
  };
  return {
    ...binding,
    bindingRoot: domainContentRoot("candidate-identity", binding),
  };
}
