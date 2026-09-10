import { aggregate } from "./aggregation.js";
import { controllerReceipt } from "./controller-receipt.js";
import path from "node:path";
import { validateReference } from "../artifact/contracts.js";
import { rootOf } from "../plan/values.js";
import { writeReleaseCandidatePassport } from "../../publication/candidate/passport.js";
async function finalizeBuild(context, jobs) {
  const { plan, file, workspace, workflow, event, upload, publishRecord } =
    context;
  const executions = [];
  let aggregated;
  try {
    aggregated = await aggregate(context, plan, jobs, executions);
  } catch (error) {
    await controllerReceipt(context, plan, jobs, false, executions);
    throw error;
  }
  const controller = await controllerReceipt(
    context,
    plan,
    jobs,
    true,
    executions,
  );
  const artifacts = {
    payloads: aggregated.payloads,
    credential: aggregated.credential || null,
    controller_receipt: controller.artifact,
  };
  if (plan.build.attestation.subject_path)
    artifacts.attestation = validateReference(
      JSON.parse(jobs.attest.outputs.artifact),
      plan,
    );
  if (
    plan.build.artifacts.release_candidate &&
    plan.source.candidate_channel !== "none"
  ) {
    writeReleaseCandidatePassport({
      outputPath: file(".buildchain/artifacts/release-candidate-passport.json"),
      coordinatesPath: file(".buildchain/artifacts/artifact-coordinates.json"),
      workspace,
      request: {
        repository: plan.run.repository,
        targetChannel: plan.source.candidate_channel,
        version: plan.source.release.version,
        sourceHeadSha: plan.source.sha,
        mergeRefSha: plan.source.sha,
        sourceTreeHash: plan.source.tree_sha,
        buildSummary: aggregated.summary,
        buildchain: {
          ref: plan.identity.ref,
          sha: plan.identity.sha,
          workflowShellRef: plan.identity.ref,
        },
        workflow: {
          name: workflow.name,
          runId: plan.run.id,
          runAttempt: plan.run.attempt,
          url: `${workflow.serverUrl}/${plan.run.repository}/actions/runs/${plan.run.id}`,
        },
        pullRequest: {
          number: event.pull_request?.number || "",
          url: event.pull_request?.html_url || "",
          headRef: event.pull_request?.head?.ref || "",
          baseRef: event.pull_request?.base?.ref || "",
        },
        gateAggregate: plan.evidence.gate_profile_json
          ? JSON.parse(plan.evidence.gate_profile_json)
          : undefined,
        familyEvidence: plan.evidence.candidate_family_json
          ? JSON.parse(plan.evidence.candidate_family_json)
          : undefined,
        consumerPolicyReceipt: {
          receipt: plan.admission.policy,
          receiptRoot: plan.admission.policy_root,
        },
        controllerReceipts: [controller.receipt],
      },
    });
    artifacts.release_candidate = await upload(
      plan,
      `${plan.artifacts.name}-release-candidate-${plan.source.sha}`,
      ["release-candidate-*.json"],
      file(".buildchain/artifacts"),
    );
  }
  artifacts.summary = await upload(
    plan,
    `${plan.artifacts.name}-summary-${plan.source.sha}`,
    ["build-summary.json", "artifact-coordinates.json"],
    file(".buildchain/artifacts"),
  );
  artifacts.diagnostics = await upload(
    plan,
    `${plan.artifacts.name}-diagnostics-summary-${plan.source.sha}`,
    ["diagnostics-summary.json"],
    file(".buildchain/artifacts"),
  );
  const result = {
    schema: "buildchain.build-result/v1",
    status: "success",
    plan_root: plan.root,
    source: plan.source,
    runtime: plan.identity,
    artifacts,
  };
  const rooted = { ...result, root: rootOf(result) };
  await publishRecord(
    plan,
    `${plan.artifacts.name}-result-${plan.source.sha}`,
    rooted,
    file(".buildchain/result"),
  );
  return rooted;
}

export function createBuildFinalizationService(
  { plan, workspace, services, workflow, event = {} },
  { readProviderArtifacts },
) {
  const context = {
    plan,
    workspace,
    workflow,
    event,
    readProviderArtifacts,
    file: (relative) => path.join(workspace, relative),
    ...services.store,
    loadFinalArtifact: services.loadFinalArtifact,
  };
  return { finalizeBuild: (jobs) => finalizeBuild(context, jobs) };
}
