import {
  aggregateReleasePassport,
  canonicalChannel,
  expectedTagSha,
} from "./evidence-binding.js";
import { read, write } from "./files.js";
import {
  RELEASE_INVOCATION_CONTRACT,
  RELEASE_PROVIDER_CONTRACT,
  createDomainReleaseTransaction,
  createReleaseInvocation,
} from "../release-invocation.js";
import { createProductPublicationPlan } from "../product-publication.js";
import fs from "node:fs";
import path from "node:path";
export async function createReleaseDocuments({
  request,
  actor,
  runId,
  repository,
  sourceSha,
  fallbackVersion,
  channel,
  candidate,
  stageCapsules,
  qualification,
  sourceBinding,
  publicationPlan,
  publicationIntent,
  octokit,
}) {
  const version = publicationPlan.version;
  const tag = publicationPlan.tag;
  const passport = aggregateReleasePassport({
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
    schema: RELEASE_INVOCATION_CONTRACT,
    publisher: {
      repository: "kungfu-systems/buildchain",
      workflow: ".github/workflows/.release-promote.yml",
      workflowSha: request["publisher-workflow-sha"],
      job: "apply",
    },
    runtime: {
      repository: "kungfu-systems/buildchain",
      commit: request["runtime-commit"],
      tree: request["runtime-tree"],
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
      contract: RELEASE_PROVIDER_CONTRACT,
      repository,
    },
    parent: {
      invocationRoot: null,
      transactionRoot: null,
      receiptRoot: null,
    },
  };
  const releaseInvocation = createReleaseInvocation(invocationInput);
  if (retainedInvocation) {
    const retained = createReleaseInvocation(retainedInvocation);
    if (
      retained.roots.invocationRoot !== releaseInvocation.roots.invocationRoot
    )
      throw new Error(
        "retained ReleaseInvocation does not match the requested resume",
      );
  }
  const releaseTransaction = createDomainReleaseTransaction({
    invocationRoot: releaseInvocation.roots.invocationRoot,
    publisherRoot: releaseInvocation.roots.publisherRoot,
    runtimeRoot: releaseInvocation.roots.runtimeRoot,
    providerRoot: releaseInvocation.roots.providerRoot,
    parentRoot: releaseInvocation.roots.parentRoot,
  });
  const productPublicationPlan = createProductPublicationPlan({
    intent: publicationIntent,
    invocationRoot: releaseInvocation.roots.invocationRoot,
    transactionRoot: releaseTransaction.transactionRoot,
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
  const productPublicationPlanPath = write(
    ".buildchain/release-tail/product-publication-plan.json",
    productPublicationPlan,
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
    productPublicationPlan,
    productPublicationPlanPath,
    tag,
    version,
  };
}
