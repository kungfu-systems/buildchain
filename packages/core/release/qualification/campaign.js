import {
  normalizeStableCandidateQualificationOptions,
  text,
  successful,
  active,
} from "./options.js";
async function ensureWorkflowEvidence({
  client,
  repository,
  workflowFile,
  workflowName,
  ref,
  headSha,
  runName,
  sourceSha = "",
  options,
}) {
  let run = await client.findWorkflowRun({
    repository,
    workflowFile,
    workflowName,
    headSha,
    runName,
    sourceSha,
  });
  if (successful(run)) return { state: "existing", run };

  let notBefore = "";
  let excludeRunId = "";
  if (!active(run)) {
    if (options.dryRun) return { state: "planned", run };
    notBefore = text(run?.created_at);
    excludeRunId = text(run?.id);
    await client.dispatchWorkflow({
      repository,
      workflowFile,
      ref,
      inputs: runName ? { buildchain_ref: headSha } : {},
    });
  }

  if (options.dryRun) return { state: "waiting", run };
  run = await client.waitForWorkflowRun({
    repository,
    workflowFile,
    workflowName,
    headSha,
    runName,
    sourceSha,
    notBefore,
    excludeRunId,
    attempts: options.pollAttempts,
    intervalMs: options.pollIntervalMs,
  });
  if (!successful(run)) {
    throw new Error(
      `${repository} ${workflowName} did not succeed for ${headSha}: ${run?.conclusion || run?.status || "not-found"}`,
    );
  }
  return { state: "produced", run };
}

export async function runStableCandidateQualification(optionsInput, client) {
  const options = normalizeStableCandidateQualificationOptions(optionsInput);
  const candidate = await client.resolveAlphaRelease(
    options.repository,
    options.candidateSha,
    { allowAncestor: true },
  );
  if (!candidate)
    return {
      schemaVersion: 1,
      contract: "kungfu-buildchain-stable-candidate-qualification",
      status: "skipped",
      reason: "exact-alpha-release-not-found",
      candidateSha: options.candidateSha,
    };

  const build = await ensureWorkflowEvidence({
    client,
    repository: options.repository,
    workflowFile: options.buildWorkflowFile,
    workflowName: options.buildWorkflowName,
    ref: candidate.tag,
    headSha: candidate.sha,
    runName: "",
    options,
  });

  let status = await client.findCommitStatus(
    options.repository,
    candidate.sha,
    options.canaryStatusContext,
  );
  let canary = {
    state: status?.state === "success" ? "existing" : "pending",
    run: undefined,
  };
  if (status?.state !== "success") {
    const canaryRef =
      options.canaryRef ||
      (await client.defaultBranch(options.canaryRepository));
    if (options.canaryRef) {
      const resolvedCanarySha = await client.resolveCommitSha(
        options.canaryRepository,
        canaryRef,
      );
      if (resolvedCanarySha !== options.canarySha) {
        throw new Error(
          `canary ref ${canaryRef} resolved to ${resolvedCanarySha || "<missing>"}, expected ${options.canarySha}`,
        );
      }
    }
    canary = await ensureWorkflowEvidence({
      client,
      repository: options.canaryRepository,
      workflowFile: options.canaryWorkflowFile,
      workflowName: options.canaryWorkflowName,
      ref: canaryRef,
      headSha: candidate.sha,
      runName: `${options.canaryWorkflowName} / ${candidate.sha}`,
      sourceSha: options.canarySha,
      options,
    });
    if (!options.dryRun) {
      status = await client.createCommitStatus({
        repository: options.repository,
        sha: candidate.sha,
        context: options.canaryStatusContext,
        targetUrl: canary.run.html_url,
        description: `No-apply ${options.canaryRepository} canary passed`,
      });
    }
  }

  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-stable-candidate-qualification",
    status: options.dryRun ? "planned" : "qualified-evidence-ready",
    dryRun: options.dryRun,
    candidate,
    build: { state: build.state, url: build.run?.html_url || "" },
    canary: {
      state: canary.state,
      ref: options.canaryRef || "default-branch",
      sha: options.canarySha,
      url: canary.run?.html_url || status?.target_url || "",
    },
    attestation: {
      context: options.canaryStatusContext,
      state: options.dryRun ? "planned" : status?.state || "",
    },
  };
}
