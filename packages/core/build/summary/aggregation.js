import { collectFinalPayloads } from "./payloads.js";
import {
  artifactNames,
  verifyExecutionIdentity,
  verifyExecution,
} from "../artifact/contracts.js";
import { resolveArtifactCoordinates } from "../artifact/coordinates.js";
import { writeJson } from "../plan/values.js";
import { assertJobResults } from "./execution.js";
import { aggregateBuildSummary } from "./artifacts.js";
import { aggregateDiagnosticsSummary } from "../../observability/diagnostics/aggregate.js";
export async function aggregate(context, plan, jobs, executions) {
  const { file, readRecord, readProviderArtifacts } = context;
  // Read all available producers before evaluating job success, so a failed
  // sibling cannot erase the completed stages from the controller receipt.
  const reads = await Promise.allSettled(
    plan.platforms.map(async (platform) => {
      const record = await readRecord(
        plan,
        artifactNames(plan, platform).execution,
        file(`.buildchain/executions/${platform.id}`),
      );
      return verifyExecutionIdentity(record, plan, platform);
    }),
  );
  for (const read of reads)
    if (read.status === "fulfilled") executions.push(read.value);
  assertJobResults(jobs, plan);
  for (const read of reads) if (read.status === "rejected") throw read.reason;
  for (const platform of plan.platforms)
    verifyExecution(
      executions.find((record) => record.platform === platform.id),
      plan,
      platform,
    );
  const { payloads, anchored, credential } = await collectFinalPayloads(
    context,
    plan,
  );
  const release = plan.source.release;
  writeJson(
    file(".buildchain/controller/anchored-version-material.json"),
    anchored,
  );
  const summary = aggregateBuildSummary({
    inputRoot: file(".buildchain/downloaded-manifests"),
    outputPath: file(".buildchain/artifacts/build-summary.json"),
    artifactName: plan.artifacts.name,
    platforms: plan.platforms,
    additionalPlatforms: credential
      ? [`${plan.build.macos_signing.platform}-credential`]
      : [],
    git: {
      repository: plan.run.repository,
      sha: plan.source.sha,
      treeSha: plan.source.tree_sha,
      ref: plan.source.ref,
      runId: plan.run.id,
      runAttempt: plan.run.attempt,
    },
    publishGate: {
      trustedEvent: true,
      channel: "none",
      allowed: false,
      reason:
        "Build produces evidence; publication requires a release authority",
    },
    publishSource: {
      ref: release.ref,
      sha: plan.source.sha,
      locked: release.locked,
      channel: release.channel,
      line: release.line,
      consumerVersion: release.version,
      releaseManifest: JSON.stringify(release.manifest),
    },
    runtime: {
      workflowShellRef: plan.identity.ref,
      requestedRef: plan.runtime?.ref || plan.identity.ref,
      ref: plan.runtime?.ref || plan.identity.ref,
      sha: plan.identity.sha,
      class: plan.runtime?.class || plan.identity.channel,
      override: plan.runtime?.origin === "runtime-parameter",
      trustDecision: "entry-selection",
      rollbackRef: plan.identity.ref,
    },
  });
  aggregateDiagnosticsSummary({
    inputRoot: file(".buildchain/downloaded-diagnostics"),
    outputPath: file(".buildchain/artifacts/diagnostics-summary.json"),
    expectedPlatformCount: plan.platforms.length,
  });
  const coordinates = resolveArtifactCoordinates({
    artifacts: await readProviderArtifacts(plan.run),
    platforms: plan.platforms,
    artifactName: plan.artifacts.name,
    artifactNameTemplate: "{artifact}-final-{platform}-{sha}",
    sourceSha: plan.source.sha,
    sourceRef: plan.source.ref,
    repository: plan.run.repository,
    runId: plan.run.id,
    runAttempt: plan.run.attempt,
  });
  for (const reference of payloads) {
    const actual = coordinates.artifacts.find(
      (entry) => String(entry.id) === String(reference.id),
    );
    if (
      !actual ||
      actual.digest.replace(/^sha256:/u, "") !==
        reference.digest.replace(/^sha256:/u, "")
    )
      throw new Error("Final artifact readback mismatch");
  }
  writeJson(
    file(".buildchain/artifacts/artifact-coordinates.json"),
    coordinates,
  );
  return { payloads, credential, summary };
}
