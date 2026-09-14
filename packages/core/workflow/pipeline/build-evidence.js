import { recordDigest } from "../../release/discussion/envelope.js";
import {
  PIPELINE_BUILD_QUALIFICATION,
  verifyPipelineBuildQualification,
} from "./build-qualification.js";
import { pipelinePlatforms } from "./platforms.js";

const RECOVERY_CHECK = "Buildchain recovery verification";

// Dispatch-created Actions checks do not satisfy protected PR checks. Preserve
// their evidence under a diagnostic name instead of shadowing normal PR checks.
export async function observePipelineBuildChecks(source, request, repository) {
  if (
    source.repository !== repository ||
    !/^[0-9a-f]{40}$/u.test(source.commit)
  )
    throw new Error("Recovery check repository or source identity drift");
  const base = `/repos/${repository}`,
    renames = [],
    eligible = [];
  for (let page = 1; page <= 20; page++) {
    const result = await request(
      `${base}/commits/${source.commit}/check-runs?filter=all&per_page=100&page=${page}`,
    );
    if (!Array.isArray(result.check_runs) || result.check_runs.length > 100)
      throw new Error("Recovery check inventory is incomplete");
    for (const check of result.check_runs) {
      const match = /^buildchain:(attempt-[0-9a-f]{64}):(\d+):(\d+)$/u.exec(
        check.external_id || "",
      );
      if (
        check.name !== "check" ||
        check.app?.slug !== "github-actions" ||
        !match
      )
        continue;
      const runId = Number(match[2]),
        runAttempt = Number(match[3]);
      if (
        check.head_sha !== source.commit ||
        ![check.id, runId, runAttempt].every(
          (value) => Number.isSafeInteger(value) && value > 0,
        )
      )
        throw new Error("Recovery check provider identity drift");
      const run = await request(
        `${base}/actions/runs/${runId}/attempts/${runAttempt}`,
      );
      if (
        run.id !== runId ||
        run.run_attempt !== runAttempt ||
        run.repository?.full_name !== repository
      )
        throw new Error("Recovery check execution identity drift");
      if (["workflow_dispatch", "repository_dispatch"].includes(run.event))
        renames.push({
          id: check.id,
          externalId: check.external_id,
          sourceHead: source.commit,
          runId,
          runAttempt,
          name: RECOVERY_CHECK,
        });
      else if (
        [
          "push",
          "pull_request",
          "pull_request_review",
          "pull_request_target",
        ].includes(run.event) &&
        run.head_sha === source.commit
      )
        eligible.push({
          id: check.id,
          runId,
          runAttempt,
          conclusion: check.conclusion,
        });
    }
    if (result.check_runs.length < 100) return { renames, eligible };
  }
  throw new Error("Recovery check inventory exceeds its complete-read bound");
}

// The archive reference is already validated against the current attempt. A
// build result is still re-read from the provider before it can admit delivery.
export async function pipelineBuildEvidence(session, host) {
  const observed = await session.journal.read();
  const current = observed.history.at(-1);
  const phase = current.phases.build;
  if (phase?.payload.state !== "success") return null;
  const references = phase.payload.materials.filter(
    (material) =>
      material.id.startsWith("build/provider-") ||
      material.id.startsWith("build/qualified-"),
  );
  if (references.length !== 1)
    throw new Error("Pipeline build requires one retained provider receipt");
  const retained = await host.materialStore(session).read(references[0]);
  let { run } = await host.runs.read(retained.runId, retained.runAttempt);
  if (run.status !== "completed" && run.id !== host.runId)
    run = await host.runs.completed(retained.runId, retained.runAttempt);
  if (retained.schema === PIPELINE_BUILD_QUALIFICATION) {
    const source = await host.source.source(
      current.generation.source.commit,
      current.generation.source.configPath,
    );
    if (
      recordDigest(source.identity) !== recordDigest(current.generation.source)
    )
      throw new Error("Recovered build source changed during qualification");
    await verifyPipelineBuildQualification(
      retained,
      source.identity,
      pipelinePlatforms(source.plan).map(({ platform }) => platform),
      host.runs,
    );
  } else {
    const verified = await host.runs.build(
      retained.runId,
      retained.runAttempt,
      current.generation.source,
      retained.jobs.map(
        (job) => job.name.match(/Build product \(([^)]+)\)$/u)?.[1],
      ),
    );
    if (recordDigest(verified) !== recordDigest(retained))
      throw new Error("Retained product build provider result changed");
  }
  return {
    run,
    readback: retained,
    sourceHead: current.generation.source.commit,
    outcome: retained.outcome,
  };
}

export async function publishPipelineBuildCheck(
  context,
  readback,
  request,
  repository,
) {
  if (
    context.source.repository !== repository ||
    recordDigest(context.source) !== recordDigest(readback.source) ||
    context.runId !== readback.runId ||
    context.runAttempt !== readback.runAttempt
  )
    throw new Error(
      "Product check source differs from independently verified build",
    );
  const externalId = `buildchain:${context.attempt}:${context.runId}:${context.runAttempt}`;
  const recovered = readback.schema === PIPELINE_BUILD_QUALIFICATION;
  let checkName = recovered ? RECOVERY_CHECK : "check";
  const output = {
    title: recovered
      ? "Buildchain recovered product verification"
      : "Buildchain product verification",
    summary: `Exact product jobs: ${readback.root}\nAttempt: ${context.attempt}`,
  };
  if (recovered) {
    const checks = await observePipelineBuildChecks(
      context.source,
      request,
      repository,
    );
    for (const change of checks.renames)
      await request(`/repos/${repository}/check-runs/${change.id}`, {
        method: "PATCH",
        body: { name: change.name },
      });
    const original = checks.eligible.find((check) =>
      readback.segments.some(
        (segment) =>
          segment.readback.runId === check.runId &&
          segment.readback.runAttempt === check.runAttempt,
      ),
    );
    // A complete replacement has no reusable original check to project onto.
    // Retain that failed execution and publish this independently qualified
    // aggregate as the required check. Protected landing still requalifies it
    // and publishes the App-bound commit status before queue admission.
    if (!original) checkName = "check";
    // Keep the eligible normal-event check identity. Only a fully requalified
    // source aggregate can repair its failed projection; original runs and
    // immutable build receipts still retain their original failure outcomes.
    if (
      original &&
      original.conclusion !== "success" &&
      readback.outcome === "success"
    )
      await request(`/repos/${repository}/check-runs/${original.id}`, {
        method: "PATCH",
        body: { status: "completed", conclusion: "success", output },
      });
  }
  return request(`/repos/${repository}/check-runs`, {
    method: "POST",
    body: {
      name: checkName,
      head_sha: context.source.commit,
      external_id: externalId,
      status: "completed",
      conclusion: readback.outcome === "success" ? "success" : "failure",
      output,
      details_url: `https://github.com/${repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}`,
    },
  });
}
