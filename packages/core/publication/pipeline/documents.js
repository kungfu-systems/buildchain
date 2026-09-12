import { recordDigest } from "../../release/discussion/envelope.js";
import { releaseTailRoot } from "../../release/release-tail-provider-plane.js";
import {
  RELEASE_INVOCATION_CONTRACT,
  RELEASE_PROVIDER_CONTRACT,
  createReleaseInvocation,
  createDomainReleaseTransaction,
} from "../../release/release-invocation.js";
import {
  validatePublicationQualificationReceipt,
  domainPublicationQualificationRoot,
} from "../publication-qualification.js";
import { verifyPipelinePublicationPlan } from "./plan.js";

export function verifyRootedPublication(value, schema) {
  const { root, ...body } = value || {};
  if (body.schema !== schema || root !== recordDigest(body))
    throw new Error(`Invalid retained ${schema} bytes`);
  return value;
}

export function verifyPipelineQualification({
  plan,
  materialization,
  qualified,
  evaluatedAt,
}) {
  verifyPipelinePublicationPlan(plan);
  verifyRootedPublication(
    materialization,
    "buildchain.pipeline-version-materialization/v1",
  );
  verifyRootedPublication(
    qualified,
    "buildchain.pipeline-publication-qualification/v1",
  );
  if (
    qualified.planRoot !== plan.root ||
    materialization.planRoot !== plan.root ||
    recordDigest(materialization.protectedSource) !==
      recordDigest(plan.source) ||
    recordDigest(qualified.source) !== recordDigest(materialization.source) ||
    materialization.material.version !== plan.version
  )
    throw new Error(
      "Publication plan, materialized source and qualification differ",
    );
  const artifacts = qualified.artifacts
    .map((artifact) => ({
      role: `${artifact.product}/${artifact.artifact}`,
      platform: artifact.platform,
      artifactRoot: artifact.digest,
      manifestRoot: artifact.manifestRoot,
    }))
    .sort((a, b) =>
      `${a.role}\0${a.platform}`.localeCompare(`${b.role}\0${b.platform}`),
    );
  validatePublicationQualificationReceipt(qualified.qualification, {
    repository: plan.source.repository,
    sourceSha: qualified.source.commit,
    sourceRoot: recordDigest(qualified.source),
    candidateRoot: recordDigest({
      planRoot: plan.root,
      source: qualified.source,
      artifacts: qualified.artifacts,
    }),
    artifactRoot: domainPublicationQualificationRoot(artifacts),
    policyDigest: plan.contractRoot,
    ...(evaluatedAt ? { evaluatedAt } : {}),
  });
  return qualified;
}

export function pipelineReleaseDocuments({
  plan,
  materialization,
  qualified,
  capsules,
  signing,
  evaluatedAt,
}) {
  verifyPipelineQualification({
    plan,
    materialization,
    qualified,
    evaluatedAt,
  });
  verifyRootedPublication(capsules, "buildchain.pipeline-product-capsules/v1");
  if (
    capsules.qualificationRoot !== qualified.root ||
    signing.planRoot !== plan.root ||
    signing.qualificationRoot !== qualified.root ||
    signing.materializationRoot !== materialization.root ||
    signing.verified !== true
  )
    throw new Error(
      "Release requires independently verified signing and capsules for this qualification",
    );
  // The Rust domain still owns publisher admission and QUALIFY/APPLY/SETTLE.
  const invocation = createReleaseInvocation({
    schema: RELEASE_INVOCATION_CONTRACT,
    publisher: plan.publisher,
    runtime: plan.runtime,
    candidate: {
      repository: qualified.source.repository,
      commit: qualified.source.commit,
      tree: qualified.source.tree,
      version: plan.version,
    },
    target: {
      channel: plan.channel,
      tag: plan.tag,
      expectedOldSha: plan.expectedTagSha,
    },
    authority: {
      policyRoot: plan.contractRoot,
      qualificationRoot: qualified.qualification.receiptRoot,
      warrantRoot: qualified.qualification.receiptRoot,
    },
    provider: {
      adapter: "built-in-provider-plane",
      contract: RELEASE_PROVIDER_CONTRACT,
      repository: qualified.source.repository,
    },
    parent: { invocationRoot: null, transactionRoot: null, receiptRoot: null },
  });
  const transaction = createDomainReleaseTransaction({
    invocationRoot: invocation.roots.invocationRoot,
    publisherRoot: invocation.roots.publisherRoot,
    runtimeRoot: invocation.roots.runtimeRoot,
    providerRoot: invocation.roots.providerRoot,
    parentRoot: invocation.roots.parentRoot,
  });
  const body = {
    schema: "kungfu.buildchain.release-passport/v4",
    repository: qualified.source.repository,
    source: qualified.source,
    // This binding explicitly retains the declared version overlay. It never
    // claims tree equivalence with the protected commit.
    versionMaterialization: materialization,
    release: { version: plan.version, tag: plan.tag, channel: plan.channel },
    candidateRoot: qualified.qualification.candidateRoot,
    policyDigest: qualified.qualification.policyDigest,
    artifactRoot: qualified.qualification.artifactRoot,
    publicationQualificationRoot: qualified.qualification.receiptRoot,
    stageCapsuleAggregateRoot: capsules.root,
    stageCapsuleRoots: capsules.capsules
      .map(({ capsule }) => capsule.capsuleRoot)
      .sort(),
    signingRoot: recordDigest(signing),
    invocationRoot: invocation.roots.invocationRoot,
    transactionRoot: transaction.transactionRoot,
  };
  const passport = { ...body, passportRoot: releaseTailRoot(body) };
  return { invocation, transaction, passport };
}
