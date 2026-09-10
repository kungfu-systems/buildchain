import { createHash } from "node:crypto";
import { optionalSha, successful } from "./options.js";
export function validatePublicBuildRun(run, workflow, repositoryName) {
  if (
    run?.repository?.full_name !== repositoryName ||
    run?.head_repository?.full_name !== repositoryName ||
    run?.workflow_id !== workflow?.id ||
    workflow?.path !== ".github/workflows/self-build-alpha-dogfood.yml" ||
    run?.name !== "Buildchain Alpha Self-Dogfood" ||
    !successful(run) ||
    !optionalSha(run?.head_sha, "source SHA")
  ) {
    throw new Error(
      "qualification requires the exact successful repository-owned public build run",
    );
  }
  return run;
}

export function resolveStableCandidateQualificationCandidate({
  sourceRun,
  buildSummary,
  repositoryName,
} = {}) {
  const evidence = buildSummary,
    runtime = evidence?.runtime;
  if (
    !successful(sourceRun) ||
    sourceRun?.repository?.full_name !== repositoryName ||
    evidence?.artifactName !== "buildchain" ||
    evidence?.contract !== "kungfu-buildchain-build-summary" ||
    evidence?.git?.repository !== repositoryName ||
    evidence?.git?.sha !== sourceRun?.head_sha ||
    String(evidence?.git?.runId) !== String(sourceRun?.id) ||
    String(evidence?.git?.runAttempt) !== String(sourceRun?.run_attempt) ||
    runtime?.ref !== "v4-alpha" ||
    runtime?.workflowShellRef !== "v4-alpha" ||
    runtime?.class !== "alpha" ||
    runtime?.override !== false ||
    runtime?.trustDecision !== "workflow-identity"
  ) {
    throw new Error(
      "public build summary does not bind the exact source run and alpha workflow identity",
    );
  }
  const platforms = evidence.platforms || [];
  const ids = platforms.map((entry) => entry.platform?.id).sort();
  if (
    evidence.platformCount !== 3 ||
    JSON.stringify(ids) !==
      JSON.stringify(["linux-x64", "macos", "windows-x64"]) ||
    platforms.some(
      (entry) =>
        entry.expectedArtifacts?.ok !== true ||
        !/^[a-f0-9]{64}$/u.test(entry.summary?.digest || "") ||
        ["install", "build", "verify"].some(
          (stage) =>
            !(entry.observability?.lifecycle?.stages?.[stage]?.eventCount > 0),
        ),
    )
  ) {
    throw new Error(
      "public build summary requires verified artifacts for all three platforms",
    );
  }
  const sha = optionalSha(runtime.sha, "observed alpha SHA");
  if (!sha) throw new Error("public build summary is missing its runtime SHA");
  return sha;
}

export async function qualifyPublicBuild(
  { repositoryName, sourceRun, buildSummary },
  client,
) {
  const sha = resolveStableCandidateQualificationCandidate({
    repositoryName,
    sourceRun,
    buildSummary,
  });
  const candidate = await client.resolveAlphaRelease(repositoryName, sha);
  if (!candidate || candidate.sha !== sha)
    throw new Error(
      "observed runtime must be an exact published alpha, never an ancestor",
    );
  const context = "buildchain-canary/buildchain-zero-input";
  const status = await client.createCommitStatus({
    repository: repositoryName,
    sha,
    context,
    targetUrl: sourceRun.html_url,
    description: "Zero-input public build passed on all three platforms",
  });
  if (status.state !== "success")
    throw new Error("public build qualification status readback failed");
  return {
    contract: "kungfu-buildchain-public-build-qualification/v1",
    candidate,
    sourceSha: sourceRun.head_sha,
    runId: sourceRun.id,
    runAttempt: sourceRun.run_attempt,
    context,
    status: status.state,
    summaryRoot: `sha256:${createHash("sha256").update(JSON.stringify(buildSummary)).digest("hex")}`,
    artifacts: buildSummary.platforms.map((entry) => ({
      platform: entry.platform.id,
      digest: entry.summary.digest,
    })),
  };
}
