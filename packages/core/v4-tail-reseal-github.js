import { v4ContentRoot } from "./v4-canonical-contracts.js";
import {
  V4TailResealFault,
  normalizeV4TailResealRequest,
} from "./v4-tail-reseal.js";

export const V4_TAIL_RESEAL_ADMISSION_CONTRACT =
  "kungfu-buildchain-v4-tail-reseal-admission/v1";

const REQUIRED_SUCCESS_JOBS = Object.freeze([
  "build / Linux ARM64",
  "build / Linux x64",
  "build / macOS ARM64",
  "build / Windows x64",
  "build / Control detached signing Linux ARM64",
  "build / Control detached signing Linux x64",
  "build / Control detached signing macOS ARM64",
  "build / Control detached signing Windows x64",
  "build / Finalize signed artifact Linux ARM64",
  "build / Finalize signed artifact Linux x64",
  "build / Finalize signed artifact Windows x64",
]);

function fault(code, path, message) {
  throw new V4TailResealFault(code, path, message);
}

function exactArtifact(artifacts, name, digest, path) {
  const matches = artifacts.filter((artifact) => artifact.name === name);
  if (matches.length !== 1)
    fault(
      "tail-reseal-artifact-ambiguous",
      path,
      "retained artifact must resolve exactly once",
    );
  const artifact = matches[0];
  if (artifact.expired === true)
    fault("tail-reseal-retention-expired", path, "retained artifact expired");
  if (artifact.digest !== digest)
    fault(
      "tail-reseal-artifact-archive-mismatch",
      path,
      "GitHub artifact archive digest drifted",
    );
  return artifact;
}

function validateSourceIdentity(normalized, sourceCommit, sourceRun) {
  if (
    sourceCommit?.sha !== normalized.source.sha ||
    sourceCommit?.tree?.sha !== normalized.source.treeSha
  )
    fault(
      "tail-reseal-source-mismatch",
      "$/sourceCommit",
      "source commit or tree readback drifted",
    );
  const workflowFile = String(sourceRun?.path || "")
    .split("@")[0]
    .replace(/^\.github\/workflows\//u, "");
  if (
    Number(sourceRun?.id) !== normalized.source.runId ||
    Number(sourceRun?.run_attempt) !== normalized.source.runAttempt ||
    sourceRun?.event !== "workflow_dispatch" ||
    sourceRun?.status !== "completed" ||
    sourceRun?.conclusion !== "failure" ||
    sourceRun?.head_sha !== normalized.source.sha ||
    workflowFile !== normalized.source.workflowFile ||
    sourceRun?.name !== normalized.source.workflowName
  )
    fault(
      "tail-reseal-source-run-mismatch",
      "$/sourceRun",
      "source run is not the exact retained failed Build run",
    );
}

function validateSourceJobs(normalized, sourceJobs) {
  const jobs = Array.isArray(sourceJobs) ? sourceJobs : [];
  const byName = new Map(jobs.map((job) => [job.name, job]));
  for (const name of REQUIRED_SUCCESS_JOBS)
    if (byName.get(name)?.conclusion !== "success")
      fault(
        "tail-reseal-prior-stage-mismatch",
        "$/sourceJobs",
        `required source job did not succeed: ${name}`,
      );
  const failedJob = jobs.find(
    (job) => Number(job.id) === normalized.failure.jobId,
  );
  const failedSteps = (failedJob?.steps || [])
    .filter((step) => step.conclusion === "failure")
    .map((step) => step.name);
  if (
    failedJob?.name !== normalized.failure.jobName ||
    failedJob?.conclusion !== "failure" ||
    JSON.stringify(failedSteps) !==
      JSON.stringify([normalized.failure.stepName])
  )
    fault(
      "tail-reseal-failure-mismatch",
      "$/sourceJobs",
      "observed failure is not the single authorized macOS tail failure",
    );
}

function validateRetainedArtifacts(normalized, sourceArtifacts) {
  for (const [index, platform] of normalized.platforms.entries()) {
    exactArtifact(
      sourceArtifacts || [],
      platform.artifactName,
      platform.artifactArchiveRoot,
      `$/sourceArtifacts/${index}/payload`,
    );
    exactArtifact(
      sourceArtifacts || [],
      platform.manifestArtifactName,
      platform.manifestArchiveRoot,
      `$/sourceArtifacts/${index}/manifest`,
    );
  }
}

function validateSigningAuthority(normalized, signingRun, signingArtifacts) {
  if (
    Number(signingRun?.id) !== normalized.signing.authorityRunId ||
    signingRun?.status !== "completed" ||
    signingRun?.conclusion !== "success" ||
    signingRun?.head_sha !== normalized.signing.runtimeSha
  )
    fault(
      "tail-reseal-signer-authority-mismatch",
      "$/signingRun",
      "signing authority run readback drifted",
    );
  exactArtifact(
    signingArtifacts || [],
    normalized.signing.resultArtifact,
    normalized.signing.resultArtifactRoot,
    "$/signingArtifacts/result",
  );
}

export function validateV4TailResealGitHubEvidence({
  request,
  sourceCommit,
  sourceRun,
  sourceJobs,
  sourceArtifacts,
  signingRun,
  signingArtifacts,
} = {}) {
  const normalized = normalizeV4TailResealRequest(request);
  validateSourceIdentity(normalized, sourceCommit, sourceRun);
  validateSourceJobs(normalized, sourceJobs);
  validateRetainedArtifacts(normalized, sourceArtifacts);
  validateSigningAuthority(normalized, signingRun, signingArtifacts);
  const payload = {
    schema: V4_TAIL_RESEAL_ADMISSION_CONTRACT,
    repository: normalized.repository,
    sourceRoot: normalized.source.sourceRoot,
    sourceRunId: normalized.source.runId,
    signingAuthorityRunId: normalized.signing.authorityRunId,
    retainedArchiveRoots: normalized.platforms.flatMap((platform) => [
      platform.artifactArchiveRoot,
      platform.manifestArchiveRoot,
    ]),
    priorFailureRoot: normalized.failure.evidenceRoot,
    retentionReadbackRoot: normalized.retention.readbackRoot,
    warrantReadbackRoot: normalized.warrant.stateReadbackRoot,
  };
  return {
    ...payload,
    admissionRoot: v4ContentRoot("tail-reseal-admission", payload),
  };
}

export { REQUIRED_SUCCESS_JOBS as V4_TAIL_RESEAL_REQUIRED_SUCCESS_JOBS };
