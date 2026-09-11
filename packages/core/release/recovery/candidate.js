import { readOnlyJson } from "./files.js";
import { resolveRecoveredStageCapsules } from "./capsules.js";
import { prepareRuntimeResumeEvidence } from "./runtime.js";
import { resolveTargetAdvance } from "./transactions.js";
import { resolveRecoveryTransaction } from "./transactions.js";
import { normalizePlatformManifests } from "./artifacts.js";
import { normalizeControllerReceipts } from "./artifacts.js";
import { normalizeProductPayloadManifests } from "./artifacts.js";
import { createRecoveredPublication } from "./publication.js";
import { downloadArtifact } from "./download.js";
import { recoverCandidateEvidence } from "./download.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAnchorProvenance } from "./provenance.js";
import { normalizeCandidateRun } from "./provenance.js";
import { recoverCandidateProvenance } from "./provenance.js";
import { selectReleaseCandidateArtifacts } from "../candidate/selection.js";
import { githubJson } from "./../candidate/transport.js";
import { validateRecoveryTargetRef } from "../release-candidate-recovery.js";
import { verifyReleaseCandidateRecovery } from "../release-candidate-recovery.js";
import { splitRepository } from "../candidate/selection.js";
import { outputPath } from "../candidate/payloads.js";
import { installationRoot } from "../../runtime/installation-root.js";
export function validateRecoveryCoordinates(
  candidateRunId,
  expectedSourceTree,
  expectedCandidateRoot,
) {
  const runId = String(candidateRunId || "").trim();
  if (!/^\d+$/.test(runId)) throw new Error("candidate run ID must be numeric");
  if (
    !String(expectedSourceTree || "").trim() &&
    !String(expectedCandidateRoot || "").trim()
  ) {
    throw new Error(
      "candidate recovery requires expectedSourceTree or expectedCandidateRoot",
    );
  }
  return runId;
}

function materializeRecoveryEvidence({
  resolvedOutput,
  recovery,
  publication,
  stageCapsules,
  repoInfo,
  targetRef,
  runtimeSha,
  publicationVersion,
  passport,
  stageCapsuleSidecar,
  runtimeRoot,
  recoveryRunId,
  recoveryRunAttempt,



  runId,
  run,
  selected,
  chosen,
  initialDownloads,
  bundleRoot,
  downloads,
  stageCapsuleFile,
  publicationQualificationFile,
}) {
  const recoveryReceiptPath = path.join(
    resolvedOutput,
    "recovery-receipt.json",
  );
  const sealedManifestPath = path.join(resolvedOutput, "sealed-bundle.json");
  const requiredArtifactsPath = path.join(
    resolvedOutput,
    "publish-required-artifacts.json",
  );
  fs.writeFileSync(
    recoveryReceiptPath,
    `${JSON.stringify(recovery.receipt, null, 2)}\n`,
  );
  if (publication.manifest)
    fs.writeFileSync(
      sealedManifestPath,
      `${JSON.stringify(publication.manifest, null, 2)}\n`,
    );
  const publishRequiredArtifacts = publication.publishRequiredArtifacts;
  fs.writeFileSync(
    requiredArtifactsPath,
    `${JSON.stringify(publishRequiredArtifacts, null, 2)}\n`,
  );
  const runtimeResumeEvidencePath = stageCapsules.length
    ? prepareRuntimeResumeEvidence({
        repoInfo,
        targetRef,
        runtimeSha,
        version: publicationVersion,
        passport,
        sidecar: stageCapsuleSidecar,
        stageCapsules,
        recovery,
        outputDir: resolvedOutput,
        runtimeRoot,
        recoveryRunId,
        recoveryRunAttempt,



      })
    : "";
  const tarballs = publication.npmArtifacts.map((entry) =>
    outputPath(entry.file.absolutePath),
  );
  return {
    enabled: true,
    action: "reused",
    repository: repoInfo.fullName,
    run: { id: runId, url: run.html_url || "", name: run.name },
    artifacts: {
      passport: selected.passport.name,
      summary: selected.summary.name,
      payloads: chosen.map((artifact) => artifact.name),
      sourceSha: selected.sourceSha,
    },
    version: publicationVersion,
    candidateVersion: publication.candidateVersion,
    candidateRoot: recovery.receipt.recovered.candidateRoot,
    artifactRoot: recovery.receipt.recovered.artifactRoot,
    receipt: recovery.receipt,
    publishRequiredArtifacts,
    paths: {
      passport: outputPath(
        initialDownloads[0].files.find(
          (file) =>
            path.basename(file.path) === "release-candidate-passport.json",
        ).absolutePath,
      ),
      buildSummary: outputPath(
        initialDownloads[1].files.find(
          (file) => path.basename(file.path) === "build-summary.json",
        ).absolutePath,
      ),
      payloads: outputPath(path.join(bundleRoot, "artifacts")),
      platformManifests: downloads.flatMap((download) =>
        download.files
          .filter((file) => path.basename(file.path) === "manifest.json")
          .map((file) => outputPath(file.absolutePath)),
      ),
      npmTarballs: tarballs,
      releaseAssets: publication.releaseAssets.map((asset) =>
        outputPath(asset.absolutePath),
      ),
      publishRequiredArtifacts: outputPath(requiredArtifactsPath),
      sealedBundleRoot: publication.manifest
        ? outputPath(publication.bundleRoot || bundleRoot)
        : "",
      sealedBundleManifest: publication.manifest
        ? outputPath(sealedManifestPath)
        : "",
      recoveryReceipt: outputPath(recoveryReceiptPath),
      stageCapsules: stageCapsuleFile
        ? outputPath(stageCapsuleFile.absolutePath)
        : "",
      publicationQualification: publicationQualificationFile
        ? outputPath(publicationQualificationFile.absolutePath)
        : "",
      runtimeResumeEvidence: runtimeResumeEvidencePath
        ? outputPath(runtimeResumeEvidencePath)
        : "",
    },
  };
}

async function readRecoveryTarget({
  provenancePassport,
  apiUrl,
  token,
  fetchImpl,
  repoInfo,
  targetSha,
  targetRef,
}) {
  const prNumber = Number(provenancePassport.pullRequest?.number || 0);
  if (!prNumber)
    throw new Error("Release Candidate Passport has no PR identity");
  const pullRequest = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}`,
  });
  const targetCommit = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/git/commits/${targetSha}`,
  });
  const targetRefState = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/git/ref/heads/${targetRef.replace(/^refs\/heads\//, "")}`,
  });
  const observedTargetSha = String(targetRefState.object?.sha || "");
  const compare = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/compare/${pullRequest.merge_commit_sha}...${targetSha}`,
  });

  return { pullRequest, targetCommit, observedTargetSha, compare };
}

async function qualifyRecoveredCandidate({
  downloads,
  passport,
  publicationNames,
  bundleRoot,
  repoInfo,
  publishArtifactKind,
  publishPackageMain,
  releasePatterns,
  channel,
  targetRef,
  pullRequest,
  rematerializeOnResume,
  runtimeSha,
  stageCapsuleSidecar,
  apiUrl,
  token,
  fetchImpl,
  transactionId,
  observedTargetSha,
  targetSha,
  targetRepository,
  runId,
  expectedWorkflowFile,
  expectedWorkflowName,
  targetCommit,
  expectedSourceTree,
  expectedCandidateRoot,
  run,
  workflow,
  anchorProvenance,
  compare,
  buildSummary,
  recoveryRunId,
}) {
  const platformManifestEvidence = normalizePlatformManifests(
    downloads,
    passport,
  );
  const controllerReceipts = normalizeControllerReceipts(downloads, passport);
  const productPayloadManifests = normalizeProductPayloadManifests(downloads);
  const publication = createRecoveredPublication({
    downloads: downloads.filter(({ artifact }) =>
      publicationNames.has(artifact.name),
    ),
    bundleRoot,
    repository: repoInfo.fullName,
    passport,
      publishArtifactKind,
    publishPackageMain,
    releasePatterns,
    platformManifests: platformManifestEvidence.manifests,
    channel,
    targetRef,
    candidateRef: pullRequest.head?.ref || "",
    rematerializeOnResume,
  });
  const stageCapsules = resolveRecoveredStageCapsules({
      runtimeSha,
    sidecar: stageCapsuleSidecar,
    passport,
    downloads,
  });
  const { version: publicationVersion, transaction: existingTransaction } =
    await resolveRecoveryTransaction({
      repoInfo,
      apiUrl,
      token,
      fetchImpl,
      transactionId,
      publicationVersion: publication.version,
    });
  const targetAdvance = await resolveTargetAdvance({
    observedTargetSha,
    targetSha,
    transactionId,
    existingTransaction,
    repoInfo,
    apiUrl,
    token,
    fetchImpl,
  });
  validateRecoveryTargetRef({
    targetSha,
    observedTargetSha,
    expectedTransactionId: transactionId,
    existingTransaction,
    ancestry: targetAdvance,
  });
  const recovery = verifyReleaseCandidateRecovery({
    candidateRepository: repoInfo.fullName,
    targetRepository,
    expectedRunId: runId,
    expectedWorkflowFile,
    expectedWorkflowName,
    channel,
    targetRef,
    targetSha,
    targetRefSha: observedTargetSha,
    targetTree: targetCommit.tree?.sha,
    expectedSourceTree,
    expectedCandidateRoot,
    expectedTransactionId: transactionId,
    existingTransaction,
    run: normalizeCandidateRun(run, repoInfo.fullName),
    workflow: {
      path: workflow.path,
      name: workflow.name,
      state: workflow.state,
    },
    anchorProvenance: normalizeAnchorProvenance(
      anchorProvenance,
      repoInfo.fullName,
    ),
    pullRequest: {
      number: pullRequest.number,
      merged: pullRequest.merged === true,
      mergeSha: pullRequest.merge_commit_sha,
      headRepository: pullRequest.head?.repo?.full_name || "",
      baseRef: pullRequest.base?.ref || "",
      authorAssociation: pullRequest.author_association || "",
      headSha: pullRequest.head?.sha || "",
      headRef: pullRequest.head?.ref || "",
    },
    ancestry: {
      status: compare.status,
      mergeIsAncestor: ["ahead", "identical"].includes(compare.status),
    },
    passport,
    buildSummary,
    controllerReceipts,
    platformManifests: platformManifestEvidence.manifests,
    platformManifestEvidence: platformManifestEvidence.evidence,
    productPayloadManifests,
    artifacts: downloads.map((download) => download.record),
    publicationVersion,
    currentToolingSha: runtimeSha,
    recoveryRunId,
  });

  return { recovery, publication, stageCapsules, publicationVersion };
}

export async function resumeFromCandidateRun({
  repository,
  targetRepository = repository,
  candidateRunId,
  expectedWorkflowFile,
  expectedWorkflowName,
  channel,
  targetRef,
  targetSha,
  expectedSourceTree = "",
  expectedCandidateRoot = "",
  runtimeSha,
  transactionId = "",
  artifactName = "",
  artifactPatterns = "",
  releasePatterns = "",
  rematerializeOnResume = false,
  requiredArtifactCount = 0,
  publishArtifactKind = "npm",
  publishPackageMain = "",
  outputDir = ".buildchain/release-candidate-recovery",
  token = "",
  apiUrl = "https://api.github.com",
  recoveryRunId,
  recoveryRunAttempt = "1",
  runtimeRoot = installationRoot(import.meta.url),



  fetchImpl = globalThis.fetch,
} = {}) {
  const repoInfo = splitRepository(repository);
  const runId = validateRecoveryCoordinates(
    candidateRunId,
    expectedSourceTree,
    expectedCandidateRoot,
  );
  const archiveDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-resume-"),
  );
  try {
    const {
      run,
      workflow,
      selected,
      resolvedOutput,
      bundleRoot,
      initialDownloads,
      passport,
      buildSummary,
      stageCapsuleSidecar,
      stageCapsuleFile,
      publicationQualificationFile,
      chosen,
      downloads,
      publicationNames,
    } = await recoverCandidateEvidence({
      repoInfo,
      runId,
      artifactName,
      artifactPatterns,
      requiredArtifactCount,
      outputDir,
      apiUrl,
      token,
      fetchImpl,
      archiveDir,
    });
    const { anchorProvenance, provenancePassport } =
      await recoverCandidateProvenance({
        passport,
        buildSummary,
        transactionId,
        repoInfo,
        artifactName,
        expectedWorkflowFile,
        expectedWorkflowName,
        channel,
        apiUrl,
        token,
        fetchImpl,
        archiveDir,
        bundleRoot,
        githubJson,
        selectReleaseCandidateArtifacts,
        downloadArtifact,
        readOnlyJson,
      });
    const { pullRequest, targetCommit, observedTargetSha, compare } =
      await readRecoveryTarget({
        provenancePassport,
        apiUrl,
        token,
        fetchImpl,
        repoInfo,
        targetSha,
        targetRef,
      });
    const { recovery, publication, stageCapsules, publicationVersion } =
      await qualifyRecoveredCandidate({
        downloads,
        passport,
        publicationNames,
        bundleRoot,
        repoInfo,
              publishArtifactKind,
        publishPackageMain,
        releasePatterns,
        channel,
        targetRef,
        pullRequest,
        rematerializeOnResume,
        runtimeSha,
        stageCapsuleSidecar,
        apiUrl,
        token,
        fetchImpl,
        transactionId,
        observedTargetSha,
        targetSha,
        targetRepository,
        runId,
        expectedWorkflowFile,
        expectedWorkflowName,
        targetCommit,
        expectedSourceTree,
        expectedCandidateRoot,
        run,
        workflow,
        anchorProvenance,
        compare,
        buildSummary,
        recoveryRunId,
      });
    return materializeRecoveryEvidence({
      resolvedOutput,
      recovery,
      publication,
      stageCapsules,
      repoInfo,
      targetRef,
      runtimeSha,
      publicationVersion,
      passport,
      stageCapsuleSidecar,
      runtimeRoot,
      recoveryRunId,
      recoveryRunAttempt,



      runId,
      run,
      selected,
      chosen,
      initialDownloads,
      bundleRoot,
      downloads,
      stageCapsuleFile,
      publicationQualificationFile,
    });
  } finally {
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
}
