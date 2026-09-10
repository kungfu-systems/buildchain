import { releaseTailRoot } from "../release-tail-provider-plane.js";
import { domainContentRoot } from "../../contracts/canonical-contracts.js";
import {
  domainPublicationQualificationRoot,
  validatePublicationQualificationReceipt,
} from "../../publication/publication-qualification.js";
import { bindProtectedPublicationSource } from "../protected-publication-source.js";
export function aggregateReleasePassport({
  candidate,
  stageCapsules,
  qualification,
  sourceBinding,
  version,
  tag,
  channel,
}) {
  const artifacts = stageCapsules.capsules.map(
    ({ publicationArtifact }) => publicationArtifact,
  );
  validatePublicationQualificationReceipt(qualification, {
    repository: candidate.repository,
    candidateRoot: `sha256:${candidate.candidateHash}`,
    sourceSha: candidate.source?.headSha,
    sourceRoot: domainContentRoot("candidate-identity", candidate.source),
    artifactRoot: domainPublicationQualificationRoot(artifacts),
    policyDigest: candidate.consumerPolicy?.receiptRoot,
  });
  if (stageCapsules.publicationQualificationRoot !== qualification.receiptRoot)
    throw new Error(
      "Stage Capsule aggregate does not bind publication qualification",
    );
  const body = {
    schema: "kungfu.buildchain.release-passport/v4",
    repository: candidate.repository,
    source: {
      ...candidate.source,
      headSha: sourceBinding.protectedSource.sha,
      treeHash: sourceBinding.protectedSource.tree,
      candidateHeadSha: sourceBinding.candidateSource.sha,
    },
    protectedPublicationSource: sourceBinding,
    release: { version, tag, channel },
    candidateRoot: qualification.candidateRoot,
    policyDigest: qualification.policyDigest,
    artifactRoot: qualification.artifactRoot,
    publicationQualificationRoot: qualification.receiptRoot,
    stageCapsuleAggregateRoot: stageCapsules.root,
    stageCapsuleRoots: stageCapsules.capsules
      .map(({ capsule }) => capsule.capsuleRoot)
      .sort(),
  };
  return { ...body, passportRoot: releaseTailRoot(body) };
}

export async function observeProtectedPublicationSource({
  octokit,
  repository,
  protectedSourceSha,
  candidate,
}) {
  const [owner, repo] = repository.split("/");
  const candidateSourceSha = candidate.source?.headSha;
  const [protectedCommitResponse, candidateCommitResponse] = await Promise.all([
    octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: protectedSourceSha,
    }),
    octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: candidateSourceSha,
    }),
  ]);
  const normalizeCommit = (response) => ({
    sha: response.data.sha,
    tree: response.data.tree?.sha,
    parents: (response.data.parents || []).map(({ sha }) => sha),
  });
  let pullRequest = null;
  if (protectedSourceSha !== candidateSourceSha) {
    const number = Number(candidate.pullRequest?.number || 0);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error(
        "tree-equivalent protected publication requires an exact pull request identity",
      );
    }
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    pullRequest = {
      number,
      merged: response.data.merged === true,
      headSha: response.data.head?.sha,
      mergeSha: response.data.merge_commit_sha,
    };
  }
  return bindProtectedPublicationSource({
    repository,
    protectedCommit: normalizeCommit(protectedCommitResponse),
    candidateCommit: normalizeCommit(candidateCommitResponse),
    pullRequest,
  });
}

export async function expectedTagSha(octokit, repository, tag) {
  const [owner, repo] = repository.split("/");
  try {
    const response = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `tags/${tag}`,
    });
    return response.data.object.sha;
  } catch (error) {
    if (Number(error?.status) === 404) return null;
    throw error;
  }
}

export function canonicalChannel(channel) {
  if (channel === "alpha") return "alpha";
  if (["release", "stable", "major"].includes(channel)) return "stable";
  throw new Error(`unsupported canonical release channel '${channel}'`);
}

export function assertCandidateEvidenceBinding({
  candidate,
  stageCapsules,
  repository,
}) {
  if (candidate.repository !== repository)
    throw new Error("candidate repository binding mismatch");
  if (
    stageCapsules.repository !== repository ||
    stageCapsules.source?.sha !== candidate.source?.headSha ||
    stageCapsules.source?.treeSha !== candidate.source?.treeHash
  )
    throw new Error("Stage Capsule repository/source binding mismatch");
}
