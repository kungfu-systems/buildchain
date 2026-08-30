import * as core from "@actions/core";
import * as github from "@actions/github";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { publishDeclarativeGitHubReleaseEvidence } from "../promote-buildchain-ref/github-release.js";
import { releaseTailRoot } from "../../packages/core/release-tail-provider-plane.js";
import { v4ContentRoot } from "../../packages/core/v4-canonical-contracts.js";
import {
  V4_RELEASE_INVOCATION_CONTRACT,
  V4_RELEASE_PROVIDER_CONTRACT,
  V4_RELEASE_RECEIPT_CONTRACT,
  createV4ReleaseInvocation,
  createV4ReleaseReceipt,
  createV4ReleaseTransaction,
} from "../../packages/core/v4-release-invocation.js";
import {
  v4PublicationQualificationRoot,
  validateV4PublicationQualificationReceipt,
} from "../../packages/core/v4-publication-qualification.js";
import { bindV4ProtectedPublicationSource } from "../../packages/core/v4-protected-publication-source.js";
import { validateReleaseCandidateRecoveryReceipt } from "../../packages/core/release-candidate-recovery.js";
import {
  applyProductPublication,
  planProductPublication,
} from "./product-provider.js";

const input = (name, required = false) =>
  core.getInput(name, { required }).trim();
const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
const write = (file, value) => {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
  return resolved;
};

export function resolveCandidateBuildSummaryPath({
  candidatePassportPath,
  declaredPath = "",
}) {
  const selected = String(declaredPath || "").trim();
  if (selected) return selected;
  const artifactsRoot = path.resolve(path.dirname(candidatePassportPath), "..");
  const matches = fs
    .readdirSync(artifactsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(artifactsRoot, entry.name, "build-summary.json"))
    .filter((entry) => fs.existsSync(entry))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `candidate-build-summary-path is required when the sealed candidate has ${matches.length === 0 ? "no" : "ambiguous"} standard summary artifacts`,
    );
  }
  return matches[0];
}

export function resolvePromotionTarget({
  candidatePassportPath,
  candidate,
  repository,
  channel,
  sourceSha,
  declaredTargetRef = "",
  declaredTargetSha = "",
}) {
  const sealedBundleRoot = path.resolve(
    path.dirname(candidatePassportPath),
    "../..",
  );
  const recoveryReceiptPath = path.join(
    path.dirname(sealedBundleRoot),
    "recovery-receipt.json",
  );
  const hasRecoveryReceipt = fs.existsSync(recoveryReceiptPath);
  const recoveryReceipt = hasRecoveryReceipt ? read(recoveryReceiptPath) : null;
  const targetRef = String(
    declaredTargetRef || recoveryReceipt?.target?.ref || "",
  ).trim();
  const targetSha = String(
    declaredTargetSha || recoveryReceipt?.target?.sha || "",
  ).trim();
  if (!targetRef || !targetSha) {
    throw new Error(
      "target-ref and target-sha are required when no standard recovery receipt supplies them",
    );
  }
  if (!hasRecoveryReceipt) {
    if (sourceSha !== targetSha)
      throw new Error(
        "protected source SHA must equal target-sha without recovery evidence",
      );
    return { targetRef, targetSha };
  }
  const validation = validateReleaseCandidateRecoveryReceipt({
    receipt: recoveryReceipt,
    passport: candidate,
    repository,
    targetChannel: channel,
    targetRef,
    targetSha,
    targetTree: candidate.source?.treeHash,
  });
  if (!validation.ok)
    throw new Error(
      `standard recovery receipt is invalid: ${validation.errors.join("; ")}`,
    );
  if (![targetSha, candidate.source?.headSha].includes(sourceSha))
    throw new Error(
      "legacy source-sha is not bound to the recovered candidate or protected target",
    );
  return { targetRef, targetSha };
}

export function aggregateV4ReleasePassport({
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
  validateV4PublicationQualificationReceipt(qualification, {
    repository: candidate.repository,
    candidateRoot: `sha256:${candidate.candidateHash}`,
    sourceSha: candidate.source?.headSha,
    sourceRoot: v4ContentRoot("candidate-identity", candidate.source),
    artifactRoot: v4PublicationQualificationRoot(artifacts),
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

async function observeProtectedPublicationSource({
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
  return bindV4ProtectedPublicationSource({
    repository,
    protectedCommit: normalizeCommit(protectedCommitResponse),
    candidateCommit: normalizeCommit(candidateCommitResponse),
    pullRequest,
  });
}

async function expectedTagSha(octokit, repository, tag) {
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

function canonicalChannel(channel) {
  if (channel === "alpha") return "alpha";
  if (["release", "stable", "major"].includes(channel)) return "stable";
  throw new Error(`unsupported canonical release channel '${channel}'`);
}

function assertCandidateEvidenceBinding({
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

function productProviderRequest({
  octokit,
  mutationOctokit,
  repository,
  targetRef,
  targetSha,
  candidate,
  candidatePassportPath,
  buildSummaryPath,
  qualification,
}) {
  const sealedBundleRoot =
    input("sealed-bundle-root") ||
    path.resolve(path.dirname(candidatePassportPath), "../..");
  const outputRoot = path.dirname(sealedBundleRoot);
  const sealedBundleManifest =
    input("sealed-bundle-manifest") ||
    path.join(outputRoot, "sealed-bundle.json");
  return {
    octokit,
    mutationOctokit,
    repository,
    targetRef,
    targetSha,
    candidate,
    candidatePassportPath,
    buildSummaryPath,
    qualification,
    requiredStatusCheck: input("required-status-check") || "check",
    publishCommand: input("publish-command"),
    sealedBundleRoot,
    sealedBundleManifest,
    requiredArtifactsPath:
      input("required-artifacts-path") ||
      path.join(outputRoot, "publish-required-artifacts.json"),
    publishMode: input("publish-mode"),
    publishAuth: input("publish-auth") || "trusted-publishing",
    publishDistTag: input("publish-dist-tag"),
    publishPackageSetOrder: input("publish-package-set-order") || "as-provided",
    publishPackageMain:
      input("publish-package-main") || read(sealedBundleManifest).npm?.name,
    publishRematerializeOnResume: core.getBooleanInput(
      "publish-rematerialize-on-resume",
    ),
    publishTransactionOverride: core.getBooleanInput(
      "publish-transaction-override",
    ),
    actor: github.context.actor,
    runId: String(github.context.runId || ""),
  };
}

async function createReleaseDocuments({
  repository,
  sourceSha,
  fallbackVersion,
  channel,
  candidate,
  stageCapsules,
  qualification,
  sourceBinding,
  publicationPlan,
  octokit,
}) {
  const version = publicationPlan.version;
  const tag = publicationPlan.tag;
  const passport = aggregateV4ReleasePassport({
    candidate,
    stageCapsules,
    qualification,
    sourceBinding,
    version,
    tag,
    channel,
  });
  const invocationPath = path.resolve(
    ".buildchain/release-tail/release-invocation.json",
  );
  const retainedInvocation = fs.existsSync(invocationPath)
    ? read(invocationPath)
    : null;
  const invocationInput = {
    schema: V4_RELEASE_INVOCATION_CONTRACT,
    publisher: {
      repository: "kungfu-systems/buildchain",
      workflow: ".github/workflows/.release-candidate-promote.yml",
      workflowSha: input("publisher-workflow-sha", true),
      job: "apply",
    },
    runtime: {
      repository: "kungfu-systems/buildchain",
      commit: input("runtime-commit", true),
      tree: input("runtime-tree", true),
    },
    candidate: {
      repository,
      commit: sourceSha,
      tree: sourceBinding.protectedSource.tree,
      version: fallbackVersion,
    },
    target: {
      channel: canonicalChannel(channel),
      tag,
      expectedOldSha: retainedInvocation
        ? retainedInvocation.target.expectedOldSha
        : await expectedTagSha(octokit, repository, tag),
    },
    authority: {
      policyRoot: candidate.consumerPolicy?.receiptRoot,
      qualificationRoot: qualification.receiptRoot,
      warrantRoot: qualification.receiptRoot,
    },
    provider: {
      adapter: "built-in-provider-plane",
      contract: V4_RELEASE_PROVIDER_CONTRACT,
      repository,
    },
    parent: {
      invocationRoot: null,
      transactionRoot: null,
      receiptRoot: null,
    },
  };
  const releaseInvocation = createV4ReleaseInvocation(invocationInput);
  if (retainedInvocation) {
    const retained = createV4ReleaseInvocation(retainedInvocation);
    if (
      retained.roots.invocationRoot !== releaseInvocation.roots.invocationRoot
    )
      throw new Error(
        "retained ReleaseInvocation does not match the requested resume",
      );
  }
  const releaseTransaction = createV4ReleaseTransaction({
    invocationRoot: releaseInvocation.roots.invocationRoot,
    publisherRoot: releaseInvocation.roots.publisherRoot,
    runtimeRoot: releaseInvocation.roots.runtimeRoot,
    providerRoot: releaseInvocation.roots.providerRoot,
    parentRoot: releaseInvocation.roots.parentRoot,
  });
  const outputDir = path.resolve(".buildchain/release-passport");
  write(invocationPath, releaseInvocation.invocation);
  const releaseTransactionPath = write(
    ".buildchain/release-tail/release-transaction.json",
    {
      ...releaseTransaction.transaction,
      transactionRoot: releaseTransaction.transactionRoot,
    },
  );
  const passportPath = write(
    path.join(outputDir, "buildchain.release.json"),
    passport,
  );
  const evidencePath = write(
    ".buildchain/release-tail/publication-evidence.json",
    {
      schema: "kungfu.buildchain.v4-publication-evidence/v1",
      repository,
      sourceSha,
      tag,
      channel,
      candidateRoot: qualification.candidateRoot,
      qualificationRoot: qualification.receiptRoot,
      releasePassportRoot: passport.passportRoot,
    },
  );
  return {
    evidencePath,
    invocationPath,
    passport,
    passportPath,
    releaseInvocation,
    releaseTransaction,
    releaseTransactionPath,
    tag,
    version,
  };
}

async function applyAndSettle({
  repository,
  sourceSha,
  channel,
  qualification,
  octokit,
  providerRequest,
  publicationPlan,
  documents,
}) {
  let productProviderResult;
  try {
    productProviderResult = await applyProductPublication(
      providerRequest,
      publicationPlan,
    );
  } catch (error) {
    if (error.providerProjection)
      write(
        ".buildchain/release-tail/product-provider-result.json",
        error.providerProjection,
      );
    throw error;
  }
  const productProviderPath = write(
    ".buildchain/release-tail/product-provider-result.json",
    productProviderResult,
  );
  const result = await publishDeclarativeGitHubReleaseEvidence({
    octokit,
    repository,
    sourceSha: productProviderResult.publication.releaseSha,
    version: documents.version,
    tag: documents.tag,
    channel,
    publishEvidencePath: documents.evidencePath,
    releasePassportPath: documents.passportPath,
    releasePassportOutputDir: path.dirname(documents.passportPath),
    additionalAssetPaths: core
      .getMultilineInput("artifact-paths")
      .filter(Boolean),
    statePath: input("state-path") || ".buildchain/release-tail/state.json",
    qualificationRoot: qualification.receiptRoot,
    failureAfterCapability: input("failure-after-capability"),
  });
  const releaseReceipt = createV4ReleaseReceipt({
    schema: V4_RELEASE_RECEIPT_CONTRACT,
    transactionRoot: documents.releaseTransaction.transactionRoot,
    outcome: "complete",
    releasePassportRoot: documents.passport.passportRoot,
    providerTransactionRoot: result.transaction.transactionRoot,
    providerStateRoot: result.transaction.stateRoot,
    providerReceiptRoots: [
      productProviderResult.root,
      ...result.transaction.receipts.map(({ receiptRoot }) => receiptRoot),
    ].sort(),
  });
  const releaseReceiptPath = write(
    ".buildchain/release-tail/release-receipt.json",
    { ...releaseReceipt.receipt, receiptRoot: releaseReceipt.receiptRoot },
  );
  return {
    productProviderPath,
    productProviderResult,
    releaseReceipt,
    releaseReceiptPath,
    result,
  };
}

function setOutputs(documents, settlement) {
  core.setOutput("release-invocation-path", documents.invocationPath);
  core.setOutput(
    "release-invocation-root",
    documents.releaseInvocation.roots.invocationRoot,
  );
  core.setOutput("release-transaction-path", documents.releaseTransactionPath);
  core.setOutput(
    "release-transaction-root",
    documents.releaseTransaction.transactionRoot,
  );
  core.setOutput("release-receipt-path", settlement.releaseReceiptPath);
  core.setOutput("release-receipt-root", settlement.releaseReceipt.receiptRoot);
  core.setOutput(
    "product-provider-result-path",
    settlement.productProviderPath,
  );
  core.setOutput(
    "product-provider-result-root",
    settlement.productProviderResult.root,
  );
  core.setOutput("release-passport-path", documents.passportPath);
  core.setOutput("release-passport-root", documents.passport.passportRoot);
  core.setOutput("transaction-state", settlement.result.transaction.state);
  core.setOutput("declaration-root", settlement.result.declarationRoot);
  core.setOutput(
    "transaction-root",
    settlement.result.transaction.transactionRoot,
  );
  core.setOutput("state-root", settlement.result.transaction.stateRoot);
  core.setOutput(
    "receipt-roots-json",
    JSON.stringify(
      [
        settlement.productProviderResult.root,
        ...settlement.result.transaction.receipts.map(
          ({ receiptRoot }) => receiptRoot,
        ),
      ].sort(),
    ),
  );
}

async function main() {
  const repository = input("repository", true);
  const declaredSourceSha = input("source-sha", true);
  const fallbackVersion = input("version", true);
  const fallbackTag = input("tag", true);
  const channel = input("channel", true);
  const candidatePassportPath = input("candidate-passport-path", true);
  const buildSummaryPath = resolveCandidateBuildSummaryPath({
    candidatePassportPath,
    declaredPath: input("candidate-build-summary-path"),
  });
  const candidate = read(candidatePassportPath);
  const { targetRef, targetSha } = resolvePromotionTarget({
    candidatePassportPath,
    candidate,
    repository,
    channel,
    sourceSha: declaredSourceSha,
    declaredTargetRef: input("target-ref"),
    declaredTargetSha: input("target-sha"),
  });
  const sourceSha = targetSha;
  const stageCapsules = read(input("stage-capsules-path", true));
  const qualification = read(input("publication-qualification-path", true));
  const token = input("token", true);
  const octokit = github.getOctokit(token);
  const mutationOctokit = github.getOctokit(input("mutation-token") || token);
  assertCandidateEvidenceBinding({ candidate, stageCapsules, repository });
  const sourceBinding = await observeProtectedPublicationSource({
    octokit,
    repository,
    protectedSourceSha: sourceSha,
    candidate,
  });
  const providerRequest = productProviderRequest({
    octokit,
    mutationOctokit,
    repository,
    targetRef,
    targetSha,
    candidate,
    candidatePassportPath,
    buildSummaryPath,
    qualification,
  });
  const publicationPlan = await planProductPublication(providerRequest, {
    fallbackVersion,
    fallbackTag,
  });
  const documents = await createReleaseDocuments({
    repository,
    sourceSha,
    fallbackVersion,
    channel,
    candidate,
    stageCapsules,
    qualification,
    sourceBinding,
    publicationPlan,
    octokit,
  });
  const settlement = await applyAndSettle({
    repository,
    sourceSha,
    channel,
    qualification,
    octokit,
    providerRequest,
    publicationPlan,
    documents,
  });
  setOutputs(documents, settlement);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => core.setFailed(error.message));
}
