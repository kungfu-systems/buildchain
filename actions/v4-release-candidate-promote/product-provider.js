import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { promoteBuildchainRefs } from "../promote-buildchain-ref/lib.js";
import { validateReleaseCandidateRecoveryReceipt } from "../../packages/core/release-candidate-recovery.js";
import { releaseTailRoot } from "../../packages/core/release-tail-provider-plane.js";

const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

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

function standardCandidatePath(
  candidatePassportPath,
  declaredPath,
  relativePath,
  label,
) {
  if (String(declaredPath || "").trim()) return declaredPath;
  const fallback = path.join(
    path.dirname(candidatePassportPath),
    "..",
    relativePath,
  );
  if (!fs.existsSync(path.resolve(fallback)))
    throw new Error(
      `${label} is required when the sealed candidate has no standard ${relativePath}`,
    );
  return fallback;
}

export function resolveCandidateProviderInputs({
  candidatePassportPath,
  sealedBundleRoot = "",
  sealedBundleManifest = "",
  requiredArtifactsPath = "",
  publishPackageMain = "",
}) {
  const resolved = {
    sealedBundleRoot: standardCandidatePath(
      candidatePassportPath,
      sealedBundleRoot,
      "payloads",
      "sealed-bundle-root",
    ),
    sealedBundleManifest: standardCandidatePath(
      candidatePassportPath,
      sealedBundleManifest,
      "sealed-bundle.json",
      "sealed-bundle-manifest",
    ),
    requiredArtifactsPath: standardCandidatePath(
      candidatePassportPath,
      requiredArtifactsPath,
      "publish-required-artifacts.json",
      "required-artifacts-path",
    ),
    publishPackageMain: String(publishPackageMain || "").trim(),
  };
  const recoveryReceiptPath = path.join(
    path.dirname(resolved.sealedBundleManifest),
    "recovery-receipt.json",
  );
  if (fs.existsSync(path.resolve(recoveryReceiptPath))) {
    resolved.releaseCandidateRecoveryReceiptPath = recoveryReceiptPath;
  }
  if (!resolved.publishPackageMain) {
    const main = read(resolved.requiredArtifactsPath).filter(
      ({ role }) => role === "main",
    );
    if (main.length !== 1 || !String(main[0]?.name || "").trim())
      throw new Error(
        "publish-package-main is required when the sealed artifact set has no unique main package",
      );
    resolved.publishPackageMain = String(main[0].name).trim();
  }
  return resolved;
}

export async function resolvePublicationTarget({
  octokit,
  repository,
  candidate,
  candidatePassportPath = "",
  channel = "",
  sourceSha,
  targetRef = "",
  targetSha = "",
}) {
  const declaredRef = String(targetRef || "").trim();
  const declaredSha = String(targetSha || "").trim();
  if (candidatePassportPath && channel) {
    try {
      const resolved = resolvePromotionTarget({
        candidatePassportPath,
        candidate,
        repository,
        channel,
        sourceSha,
        declaredTargetRef: declaredRef,
        declaredTargetSha: declaredSha,
      });
      return { sourceSha: resolved.targetSha, ...resolved };
    } catch (error) {
      if (
        declaredRef ||
        declaredSha ||
        !String(error?.message || "").includes(
          "target-ref and target-sha are required",
        )
      )
        throw error;
    }
  } else if (declaredRef || declaredSha) {
    if (!declaredRef || !declaredSha || sourceSha !== declaredSha)
      throw new Error(
        "declared publication target requires matching target-ref, target-sha, and source-sha",
      );
    return { sourceSha, targetRef: declaredRef, targetSha: declaredSha };
  }
  if (sourceSha !== candidate.source?.headSha)
    throw new Error(
      "legacy promotion target recovery requires the exact candidate source SHA",
    );
  const number = Number(candidate.pullRequest?.number || 0);
  const baseRef = String(candidate.pullRequest?.baseRef || "").trim();
  if (!Number.isSafeInteger(number) || number <= 0 || !baseRef)
    throw new Error(
      "legacy promotion target recovery requires an exact pull request and base ref",
    );
  const [owner, repo] = repository.split("/");
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  const mergeSha = String(data.merge_commit_sha || "").trim();
  if (
    data.merged !== true ||
    data.base?.ref !== baseRef ||
    !/^[0-9a-f]{40}$/u.test(mergeSha)
  )
    throw new Error(
      "legacy promotion target recovery requires the exact merged pull request",
    );
  return { sourceSha: mergeSha, targetRef: baseRef, targetSha: mergeSha };
}

export function activateExactPnpm({ temporaryRoot = os.tmpdir() } = {}) {
  const shimDirectory = fs.mkdtempSync(
    path.join(temporaryRoot, "buildchain-pnpm-"),
  );
  const shimPath = path.join(shimDirectory, "pnpm");
  fs.writeFileSync(shimPath, '#!/bin/sh\nexec corepack pnpm@11.7.0 "$@"\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(shimDirectory, "pnpm.cmd"),
    "@echo off\r\ncorepack pnpm@11.7.0 %*\r\n",
  );
  process.env.PATH = `${shimDirectory}${path.delimiter}${process.env.PATH || ""}`;
  return shimPath;
}

export function selectProductPublicationPlan(
  result,
  {
    fallbackVersion = "",
    fallbackTag = "",
    fallbackCandidateVersion = "",
  } = {},
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
  const plannedCandidateVersion = String(
    planned?.releaseCandidateVersion || "",
  ).trim();
  const sealedCandidateVersion = String(fallbackCandidateVersion || "").trim();
  if (
    plannedCandidateVersion &&
    sealedCandidateVersion &&
    plannedCandidateVersion !== sealedCandidateVersion
  )
    throw new Error(
      "product publication planning drifted from the sealed candidate version",
    );
  return {
    version,
    tag,
    candidateVersion: plannedCandidateVersion || sealedCandidateVersion,
  };
}

export function sealedCandidateVersion(request) {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(request.sealedBundleManifest), "utf8"),
  );
  const name = String(manifest?.npm?.name || "").trim();
  const version = String(manifest?.npm?.version || "").trim();
  if (name !== request.publishPackageMain || !version)
    throw new Error(
      "sealed candidate manifest omitted the exact main package version",
    );
  return version;
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
  releaseCandidateVersion = String(request.candidate.target?.version || ""),
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
    expectedTransactionId: request.expectedTransactionId,
    expectedPublicationVersion,
    requirePublicationQualification: false,
    publicationQualificationReceiptJson: JSON.stringify(request.qualification),
    publicationUsedQualificationNoncesJson: "[]",
    releasePassport: false,
    promoteOnlyReleaseCandidate: true,
    releaseCandidatePassportPath: request.candidatePassportPath,
    releaseCandidateBuildSummaryPath: request.buildSummaryPath,
    releaseCandidateVersion,
    releaseCandidateRecoveryReceiptPath:
      request.releaseCandidateRecoveryReceiptPath || "",
    actor: request.actor,
    runId: request.runId,
    publishTransactionOverride: request.publishTransactionOverride,
  };
}

export async function planProductPublication(
  request,
  { fallbackVersion = "", fallbackTag = "" } = {},
) {
  const candidateVersion = sealedCandidateVersion(request);
  const result = await promoteBuildchainRefs(
    promotionOptions(request, { dryRun: true }, candidateVersion),
  );
  return selectProductPublicationPlan(result, {
    fallbackVersion,
    fallbackTag,
    fallbackCandidateVersion: candidateVersion,
  });
}

export async function applyProductPublication(request, plan) {
  execFileSync("corepack", ["enable", "pnpm"], { stdio: "inherit" });
  const result = await promoteBuildchainRefs(
    promotionOptions(
      request,
      {
        dryRun: false,
        expectedPublicationVersion: plan.version,
      },
      plan.candidateVersion,
    ),
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
