import { v4ContentRoot } from "./v4-canonical-contracts.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function exactSha(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!SHA_PATTERN.test(normalized)) {
    throw new Error(`${label} must be an exact Git SHA`);
  }
  return normalized;
}

function exactParents(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an ordered Git parent list`);
  }
  return value.map((entry, index) => exactSha(entry, `${label}[${index}]`));
}

export function bindV4ProtectedPublicationSource({
  repository,
  protectedCommit,
  candidateCommit,
  pullRequest,
} = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(String(repository || ""))) {
    throw new Error("protected publication source requires owner/repository");
  }
  const protectedSource = {
    sha: exactSha(protectedCommit?.sha, "protected source SHA"),
    tree: exactSha(protectedCommit?.tree, "protected source tree"),
    parents: exactParents(protectedCommit?.parents, "protected source parents"),
  };
  const candidateSource = {
    sha: exactSha(candidateCommit?.sha, "candidate source SHA"),
    tree: exactSha(candidateCommit?.tree, "candidate source tree"),
    parents: exactParents(candidateCommit?.parents, "candidate source parents"),
  };
  if (protectedSource.tree !== candidateSource.tree) {
    throw new Error(
      "protected publication source tree does not match the qualified candidate tree",
    );
  }

  let mode = "exact-commit";
  let pullRequestNumber = null;
  if (protectedSource.sha !== candidateSource.sha) {
    mode = "merge-equivalent";
    const sameParents =
      protectedSource.parents.length === candidateSource.parents.length &&
      protectedSource.parents.every(
        (parent, index) => parent === candidateSource.parents[index],
      );
    if (!sameParents) {
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
      !candidateSource.parents.includes(pullRequestHead)
    ) {
      throw new Error(
        "protected publication source does not match the merged pull request and qualified merge candidate",
      );
    }
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
    bindingRoot: v4ContentRoot("candidate-identity", binding),
  };
}
