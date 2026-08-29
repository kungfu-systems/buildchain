import fs from "node:fs";
import path from "node:path";

import { promoteBuildchainRefs } from "../promote-buildchain-ref/lib.js";
import { releaseTailRoot } from "../../packages/core/release-tail-provider-plane.js";

export function selectProductPublicationPlan(
  result,
  { fallbackVersion = "", fallbackTag = "" } = {},
) {
  const planned = result?.updates?.find(
    ({ action }) => action === "dry-run-publish-transaction",
  );
  const version = String(planned?.version || fallbackVersion || "").trim();
  const tag = String(
    planned?.publicTag || planned?.tag || fallbackTag || "",
  ).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error(
      "product publication planning did not produce an exact version",
    );
  if (tag !== `v${version}`)
    throw new Error(
      "product publication planning produced a mismatched exact tag",
    );
  return {
    version,
    tag,
    candidateVersion: String(planned?.releaseCandidateVersion || "").trim(),
  };
}

function providerProjection({ result, targetRef, targetSha, plan }) {
  const transaction = result?.publishTransaction || null;
  const projection = {
    schema: "kungfu.buildchain.v4-product-provider-result/v1",
    target: { ref: targetRef, sha: targetSha },
    publication: {
      version: String(transaction?.version || plan.version || ""),
      exactTag: String(
        transaction?.publicReleaseTag ||
          transaction?.exactTag ||
          plan.tag ||
          "",
      ),
      releaseSha: String(transaction?.releaseSha || ""),
      state: String(transaction?.state || ""),
      finalizationNeeded: transaction?.finalizationNeeded === true,
    },
    promotedSha: String(result?.sha || ""),
    updates: (result?.updates || []).map(
      ({ action, ref, tag, sha, version }) => ({
        action: String(action || ""),
        ref: String(ref || ""),
        tag: String(tag || ""),
        sha: String(sha || ""),
        version: String(version || ""),
      }),
    ),
  };
  return { ...projection, root: releaseTailRoot(projection) };
}

function promotionOptions(
  request,
  { dryRun, expectedPublicationVersion = "" },
) {
  const [owner, repo] = request.repository.split("/");
  return {
    octokit: request.octokit,
    owner,
    repo,
    sha: request.targetSha,
    targetRef: request.targetRef,
    dryRun,
    allowRepository: request.repository,
    requireGovernance: !dryRun,
    requireVersionState: true,
    requiredStatusCheck: request.requiredStatusCheck || "check",
    statusCheckOctokit: request.octokit,
    pullRequestOctokit: request.mutationOctokit,
    refUpdateOctokit: request.octokit,
    tagUpdateOctokit: request.mutationOctokit,
    branchProtectionBypassApps: "github-actions",
    branchProtectionBypassUsers: "",
    branchProtectionBypassTeams: "",
    publishTransaction: true,
    publishCommand: request.publishCommand,
    publishSealedBundleRoot: request.sealedBundleRoot,
    publishSealedBundleManifest: request.sealedBundleManifest,
    publishRequiredArtifactsJson: fs.readFileSync(
      path.resolve(request.requiredArtifactsPath),
      "utf8",
    ),
    publishMode: request.publishMode,
    publishAuth: request.publishAuth || "trusted-publishing",
    publishDistTag: request.publishDistTag,
    publishPackageSetOrder: request.publishPackageSetOrder || "as-provided",
    publishPackageMain: request.publishPackageMain,
    publishRematerializeOnResume: request.publishRematerializeOnResume,
    expectedPublicationVersion,
    requirePublicationQualification: false,
    publicationQualificationReceiptJson: JSON.stringify(request.qualification),
    publicationUsedQualificationNoncesJson: "[]",
    releasePassport: false,
    promoteOnlyReleaseCandidate: true,
    releaseCandidatePassportPath: request.candidatePassportPath,
    releaseCandidateBuildSummaryPath: request.buildSummaryPath,
    releaseCandidateVersion: String(request.candidate.target?.version || ""),
    actor: request.actor,
    runId: request.runId,
    publishTransactionOverride: request.publishTransactionOverride,
  };
}

export async function planProductPublication(
  request,
  { fallbackVersion = "", fallbackTag = "" } = {},
) {
  const result = await promoteBuildchainRefs(
    promotionOptions(request, { dryRun: true }),
  );
  return selectProductPublicationPlan(result, {
    fallbackVersion,
    fallbackTag,
  });
}

export async function applyProductPublication(request, plan) {
  const result = await promoteBuildchainRefs(
    promotionOptions(request, {
      dryRun: false,
      expectedPublicationVersion: plan.version,
    }),
  );
  const projection = providerProjection({
    result,
    targetRef: request.targetRef,
    targetSha: request.targetSha,
    plan,
  });
  if (
    projection.publication.state !== "complete" ||
    projection.publication.finalizationNeeded
  )
    throw Object.assign(
      new Error(
        `product provider stopped in ${projection.publication.state || "unknown"}: finalization-needed=${projection.publication.finalizationNeeded}`,
      ),
      { providerProjection: projection },
    );
  if (
    projection.publication.version !== plan.version ||
    projection.publication.exactTag !== plan.tag
  )
    throw new Error(
      "product provider result drifted from the rooted publication plan",
    );
  if (!/^[0-9a-f]{40}$/u.test(projection.publication.releaseSha))
    throw new Error(
      "product provider result omitted the exact public release SHA",
    );
  return projection;
}
