// SPDX-License-Identifier: Apache-2.0

import { AWS_MACOS_JIT_CONTROLLER_CONTRACT } from "./aws-macos-jit-controller-core.mjs";
import {
  assertMacosBudgetLaunchGate,
  assertOwnership,
  awsArgs,
  awsJson,
  commandResult,
  ghJson,
  requireSuccess,
} from "./aws-macos-jit-controller-runtime.mjs";

const MACOS_JIT_RUNNER_LABEL_PREFIX = "aws-us-ec2-macos-jit-";

function sourceRefName(ref) {
  return ref.replace(/^refs\/heads\//, "");
}

function sourceRefApiPath(plan) {
  return `repos/${plan.repository}/git/refs/heads/${sourceRefName(plan.source.ref)}`;
}

function priorOwnershipPlan(plan) {
  return {
    campaign: plan.campaign,
    source: plan.previousSource,
  };
}

function assertRunMatchesPolicy(policy, run, jobs, jobCount, artifactCount) {
  if (policy === "unused") {
    if (jobCount !== 0 || artifactCount !== 0) {
      throw new Error(
        `macOS campaign run ${run.id} already has jobs or artifacts`,
      );
    }
    return;
  }
  if (policy === "preflight-failure") {
    const jobList = jobs.jobs || [];
    const failedJobs = jobList.filter((job) => job.conclusion === "failure");
    const nonFailedJobs = jobList.filter((job) => job.conclusion !== "failure");
    const hasJitLabel = jobList.some((job) =>
      (job.labels || []).some((label) =>
        String(label.name || label).startsWith(MACOS_JIT_RUNNER_LABEL_PREFIX),
      ),
    );
    if (
      run.status !== "completed" ||
      run.conclusion !== "failure" ||
      jobCount === 0 ||
      artifactCount === 0 ||
      jobList.some((job) => job.status !== "completed") ||
      failedJobs.length !== 1 ||
      !String(failedJobs[0].name || "").endsWith(" / Trust gate") ||
      nonFailedJobs.some((job) => job.conclusion !== "skipped") ||
      hasJitLabel
    ) {
      throw new Error(
        `macOS campaign run ${run.id} is not an exact preflight Trust gate failure`,
      );
    }
    return;
  }
  if (
    run.status !== "completed" ||
    run.conclusion !== "failure" ||
    jobCount === 0 ||
    artifactCount === 0 ||
    (jobs.jobs || []).some((job) => job.status !== "completed")
  ) {
    throw new Error(
      `macOS campaign run ${run.id} is not a terminal failed run with retained evidence`,
    );
  }
}

function assertExactStartupFailure(run, jobCount, artifactCount) {
  if (
    run.status !== "completed" ||
    run.conclusion !== "startup_failure" ||
    jobCount !== 0 ||
    artifactCount !== 0
  ) {
    throw new Error(
      `macOS campaign run ${run.id} is not an exact startup failure`,
    );
  }
}

function assertExactSuccessfulRun(run, jobs, jobCount, artifactCount) {
  if (
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    jobCount === 0 ||
    artifactCount === 0 ||
    (jobs.jobs || []).some((job) => job.status !== "completed")
  ) {
    throw new Error(
      `macOS campaign run ${run.id} is not a terminal successful run with retained evidence`,
    );
  }
}

function classifyCampaignRun(plan, run) {
  const startupFailure = plan.github.startupFailureRuns.find(
    ({ runId }) => runId === String(run.id),
  );
  const historicalTerminalFailure =
    plan.github.historicalTerminalFailureRuns.find(
      ({ runId }) => runId === String(run.id),
    );
  const historicalPreflightFailure =
    plan.github.historicalPreflightFailureRuns.find(
      ({ runId }) => runId === String(run.id),
    );
  const preflightFailure = plan.github.preflightFailureRunIds.includes(
    String(run.id),
  );
  const successfulRun = plan.github.successfulRunIds.includes(String(run.id));
  return {
    startupFailure,
    historicalTerminalFailure,
    historicalPreflightFailure,
    successfulRun,
    expectedSourceSha:
      startupFailure?.sourceSha ||
      historicalTerminalFailure?.sourceSha ||
      historicalPreflightFailure?.sourceSha ||
      plan.previousSource.sha,
    classification: startupFailure
      ? "startup-failure"
      : historicalTerminalFailure
        ? "historical-terminal-failure"
        : historicalPreflightFailure
          ? "historical-preflight-failure"
          : successfulRun
            ? "successful-run"
            : preflightFailure
              ? "preflight-failure"
              : plan.github.priorRunPolicy,
  };
}

function exactReceiptInventory(receipts, classification, withSource = false) {
  return receipts
    .filter((receipt) => receipt.classification === classification)
    .map((receipt) =>
      withSource
        ? { runId: receipt.runId, sourceSha: receipt.sourceSha }
        : receipt.runId,
    )
    .sort(
      (left, right) =>
        Number(withSource ? left.runId : left) -
        Number(withSource ? right.runId : right),
    );
}

function assertExactReceiptInventories(plan, receipts) {
  if (plan.github.priorRunPolicy === "unused") return;
  const inventories = [
    ["terminal-failure", plan.github.terminalFailureRunIds, false],
    ["preflight-failure", plan.github.preflightFailureRunIds, false],
    ["successful-run", plan.github.successfulRunIds, false],
    ["startup-failure", plan.github.startupFailureRuns, true],
    [
      "historical-terminal-failure",
      plan.github.historicalTerminalFailureRuns,
      true,
    ],
    [
      "historical-preflight-failure",
      plan.github.historicalPreflightFailureRuns,
      true,
    ],
  ];
  for (const [classification, expected, withSource] of inventories) {
    const observed = exactReceiptInventory(
      receipts,
      classification,
      withSource,
    );
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw new Error(
        `macOS campaign ${classification} inventory does not match the confirmed runs`,
      );
    }
  }
}

function campaignRunReceipts(plan) {
  const branch = sourceRefName(plan.source.ref);
  const response = ghJson(
    [
      "api",
      `repos/${plan.repository}/actions/workflows/${plan.github.workflowId}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=100`,
    ],
    undefined,
    "macOS campaign workflow run lookup",
  );
  const matching = (response.workflow_runs || []).filter(
    (run) => run.head_branch === branch,
  );
  if (Number(response.total_count || matching.length) !== matching.length) {
    throw new Error("macOS campaign workflow run inventory is incomplete");
  }
  const receipts = [];
  for (const run of matching) {
    const classification = classifyCampaignRun(plan, run);
    if (run.head_sha !== classification.expectedSourceSha) {
      throw new Error(
        `macOS campaign run ${run.id} is bound to an unexpected source`,
      );
    }
    const jobs = ghJson(
      [
        "api",
        `repos/${plan.repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
      ],
      undefined,
      `macOS campaign run ${run.id} job lookup`,
    );
    const artifacts = ghJson(
      ["api", `repos/${plan.repository}/actions/runs/${run.id}/artifacts`],
      undefined,
      `macOS campaign run ${run.id} artifact lookup`,
    );
    const jobCount = Number(jobs.total_count || (jobs.jobs || []).length || 0);
    const artifactCount = Number(
      artifacts.total_count || (artifacts.artifacts || []).length || 0,
    );
    if (classification.startupFailure) {
      assertExactStartupFailure(run, jobCount, artifactCount);
    } else if (classification.successfulRun) {
      assertExactSuccessfulRun(run, jobs, jobCount, artifactCount);
    } else {
      assertRunMatchesPolicy(
        classification.historicalTerminalFailure
          ? "terminal-failure"
          : classification.historicalPreflightFailure
            ? "preflight-failure"
            : plan.github.priorRunPolicy,
        run,
        jobs,
        jobCount,
        artifactCount,
      );
    }
    receipts.push({
      runId: String(run.id),
      sourceSha: String(run.head_sha || ""),
      classification: classification.classification,
      status: String(run.status || "unknown"),
      conclusion: String(run.conclusion || ""),
      jobCount,
      artifactCount,
      artifacts: (artifacts.artifacts || []).map((artifact) => ({
        id: String(artifact.id),
        name: String(artifact.name || ""),
        sizeInBytes: Number(artifact.size_in_bytes || 0),
        digest: String(artifact.digest || ""),
        expired: artifact.expired === true,
      })),
    });
  }
  assertExactReceiptInventories(plan, receipts);
  return receipts;
}

function assertSourceLineage(plan) {
  const currentRef = ghJson(
    ["api", sourceRefApiPath(plan)],
    undefined,
    "macOS campaign source ref preflight",
  );
  if (currentRef.object?.sha !== plan.previousSource.sha) {
    throw new Error("macOS campaign source ref is not at previousSourceSha");
  }
  const nextCommit = ghJson(
    ["api", `repos/${plan.repository}/commits/${plan.source.sha}`],
    undefined,
    "macOS campaign replacement source preflight",
  );
  if (String(nextCommit.sha || "").toLowerCase() !== plan.source.sha) {
    throw new Error("GitHub did not resolve the replacement source SHA");
  }
  const comparison = ghJson(
    [
      "api",
      `repos/${plan.repository}/compare/${plan.previousSource.sha}...${plan.source.sha}`,
    ],
    undefined,
    "macOS campaign forward-source preflight",
  );
  if (
    comparison.status !== "ahead" ||
    comparison.merge_base_commit?.sha !== plan.previousSource.sha
  ) {
    throw new Error(
      "replacement source must be a strict descendant of previousSourceSha",
    );
  }
  return {
    currentRefSha: currentRef.object.sha,
    comparisonStatus: comparison.status,
  };
}

function readOwnedCampaignResources(plan, profile) {
  const priorPlan = priorOwnershipPlan(plan);
  const host = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-hosts",
      "--host-ids",
      plan.aws.hostId,
      "--output",
      "json",
    ],
    "macOS campaign source rebind host preflight",
  ).Hosts?.[0];
  if (!host || host.State !== "available") {
    throw new Error("macOS campaign source rebind host is not available");
  }
  assertOwnership(host.Tags, priorPlan);
  const instance = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-instances",
      "--instance-ids",
      plan.aws.instanceId,
      "--output",
      "json",
    ],
    "macOS campaign source rebind instance preflight",
  ).Reservations?.[0]?.Instances?.[0];
  if (
    !instance ||
    instance.State?.Name !== "running" ||
    instance.Placement?.HostId !== plan.aws.hostId
  ) {
    throw new Error("macOS campaign source rebind instance identity mismatch");
  }
  assertOwnership(instance.Tags, priorPlan);
  if (
    (instance.Tags || []).some(
      (entry) =>
        entry.Key === "kungfu:jit-parameter" && String(entry.Value || ""),
    )
  ) {
    throw new Error("macOS campaign instance already has JIT residue");
  }
  const volumeIds = (instance.BlockDeviceMappings || [])
    .map((mapping) => mapping.Ebs?.VolumeId)
    .filter(Boolean);
  if (volumeIds.length !== 1) {
    throw new Error("macOS campaign must have exactly one attached volume");
  }
  const volume = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-volumes",
      "--volume-ids",
      volumeIds[0],
      "--output",
      "json",
    ],
    "macOS campaign source rebind volume preflight",
  ).Volumes?.[0];
  if (!volume || volume.State !== "in-use" || volume.Encrypted !== true) {
    throw new Error("macOS campaign source rebind volume identity mismatch");
  }
  assertOwnership(volume.Tags, priorPlan);
  return { host, instance, volume };
}

function assertExactCampaignInventory(plan, profile, resources) {
  const ownedHosts =
    awsJson(
      plan,
      profile,
      [
        "ec2",
        "describe-hosts",
        "--filter",
        `Name=tag:kungfu:campaign-id,Values=${plan.campaign.id}`,
        "--output",
        "json",
      ],
      "macOS campaign owned host inventory",
    ).Hosts || [];
  const ownedInstances = (
    awsJson(
      plan,
      profile,
      [
        "ec2",
        "describe-instances",
        "--filters",
        `Name=tag:kungfu:campaign-id,Values=${plan.campaign.id}`,
        "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down",
        "--output",
        "json",
      ],
      "macOS campaign owned instance inventory",
    ).Reservations || []
  ).flatMap((reservation) => reservation.Instances || []);
  const ownedVolumes =
    awsJson(
      plan,
      profile,
      [
        "ec2",
        "describe-volumes",
        "--filters",
        `Name=tag:kungfu:campaign-id,Values=${plan.campaign.id}`,
        "--output",
        "json",
      ],
      "macOS campaign owned volume inventory",
    ).Volumes || [];
  if (
    ownedHosts.length !== 1 ||
    ownedHosts[0].HostId !== resources.host.HostId ||
    ownedInstances.length !== 1 ||
    ownedInstances[0].InstanceId !== resources.instance.InstanceId ||
    ownedVolumes.length !== 1 ||
    ownedVolumes[0].VolumeId !== resources.volume.VolumeId
  ) {
    throw new Error("macOS campaign resource inventory is not exact");
  }
}

function assertZeroCampaignResidue(plan, profile) {
  const parameters =
    awsJson(
      plan,
      profile,
      [
        "ssm",
        "describe-parameters",
        "--parameter-filters",
        `Key=Name,Option=BeginsWith,Values=/kungfu/burst/macos/${plan.campaign.id}/`,
        "--output",
        "json",
      ],
      "macOS campaign JIT parameter inventory",
    ).Parameters || [];
  if (parameters.length !== 0) {
    throw new Error("macOS campaign already has SSM JIT parameters");
  }
  const runners =
    ghJson(
      ["api", `repos/${plan.repository}/actions/runners?per_page=100`],
      undefined,
      "macOS campaign runner inventory",
    ).runners || [];
  const matchingRunners = runners.filter((runner) =>
    (runner.labels || []).some((label) =>
      String(label.name || label).startsWith(MACOS_JIT_RUNNER_LABEL_PREFIX),
    ),
  );
  if (matchingRunners.length !== 0) {
    throw new Error("macOS campaign already has a registered JIT runner");
  }
  const evidenceObjects = {};
  const historicalTerminalSources =
    plan.github.historicalTerminalFailureRuns.map(({ sourceSha }) => sourceSha);
  const historicalPreflightSources =
    plan.github.historicalPreflightFailureRuns.map(
      ({ sourceSha }) => sourceSha,
    );
  const evidenceSources = [
    ...new Set([
      plan.previousSource.sha,
      ...historicalTerminalSources,
      ...historicalPreflightSources,
      plan.source.sha,
    ]),
  ];
  for (const sourceSha of evidenceSources) {
    const evidence = awsJson(
      plan,
      profile,
      [
        "s3api",
        "list-objects-v2",
        "--bucket",
        plan.aws.evidenceBucket,
        "--prefix",
        `macos/${sourceSha}/`,
        "--max-keys",
        "1000",
        "--output",
        "json",
      ],
      `macOS campaign evidence inventory for ${sourceSha}`,
    );
    if (evidence.IsTruncated === true) {
      throw new Error(
        `macOS campaign source ${sourceSha} evidence inventory is incomplete`,
      );
    }
    const objects = (evidence.Contents || []).map((object) => ({
      key: String(object.Key || ""),
      size: Number(object.Size || 0),
      etag: String(object.ETag || ""),
    }));
    const count = Number(
      evidence.KeyCount || (evidence.Contents || []).length || 0,
    );
    const terminalEvidenceSource =
      (sourceSha === plan.previousSource.sha &&
        plan.github.priorRunPolicy === "terminal-failure") ||
      historicalTerminalSources.includes(sourceSha);
    if (
      (!terminalEvidenceSource && count !== 0) ||
      (terminalEvidenceSource && count === 0)
    ) {
      throw new Error(
        `macOS campaign source ${sourceSha} bootstrap evidence does not match the rebind policy`,
      );
    }
    evidenceObjects[sourceSha] = objects;
  }
  return {
    priorRuns: campaignRunReceipts(plan),
    jitParameterCount: parameters.length,
    runnerCount: matchingRunners.length,
    evidenceObjects,
  };
}

function assertMacosJitSourceRebindPreflight(plan, profile) {
  const controlPlane = assertMacosBudgetLaunchGate(plan, profile);
  const source = assertSourceLineage(plan);
  const resources = readOwnedCampaignResources(plan, profile);
  assertExactCampaignInventory(plan, profile, resources);
  const residue = assertZeroCampaignResidue(plan, profile);
  return {
    ...controlPlane,
    ...source,
    ...residue,
    resourceIds: {
      hostId: resources.host.HostId,
      instanceId: resources.instance.InstanceId,
      volumeId: resources.volume.VolumeId,
    },
  };
}
function setCampaignSourceTags(plan, profile, sourceSha) {
  requireSuccess(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "create-tags",
        "--resources",
        plan.aws.hostId,
        plan.aws.instanceId,
        plan.aws.volumeId,
        "--tags",
        `Key=kungfu:source-sha,Value=${sourceSha}`,
      ]),
    ),
    `macOS campaign source tag update to ${sourceSha}`,
  );
}

function updateCampaignSourceRef(plan, sourceSha, force) {
  requireSuccess(
    commandResult("gh", [
      "api",
      "--method",
      "PATCH",
      sourceRefApiPath(plan),
      "-f",
      `sha=${sourceSha}`,
      "-F",
      `force=${force ? "true" : "false"}`,
    ]),
    `macOS campaign source ref update to ${sourceSha}`,
  );
}

function assertReboundResources(plan, profile) {
  const resources = [
    awsJson(
      plan,
      profile,
      [
        "ec2",
        "describe-hosts",
        "--host-ids",
        plan.aws.hostId,
        "--output",
        "json",
      ],
      "macOS campaign rebound host readback",
    ).Hosts?.[0],
    awsJson(
      plan,
      profile,
      [
        "ec2",
        "describe-instances",
        "--instance-ids",
        plan.aws.instanceId,
        "--output",
        "json",
      ],
      "macOS campaign rebound instance readback",
    ).Reservations?.[0]?.Instances?.[0],
    awsJson(
      plan,
      profile,
      [
        "ec2",
        "describe-volumes",
        "--volume-ids",
        plan.aws.volumeId,
        "--output",
        "json",
      ],
      "macOS campaign rebound volume readback",
    ).Volumes?.[0],
  ];
  for (const resource of resources) {
    if (!resource)
      throw new Error("macOS campaign source rebind readback failed");
    assertOwnership(resource.Tags, plan);
  }
  const ref = ghJson(
    ["api", sourceRefApiPath(plan)],
    undefined,
    "macOS campaign rebound source ref readback",
  );
  if (ref.object?.sha !== plan.source.sha) {
    throw new Error("macOS campaign rebound source ref readback mismatch");
  }
}

export function executeMacosJitSourceRebind(plan, { profile = "" } = {}) {
  if (
    plan?.contract !== AWS_MACOS_JIT_CONTROLLER_CONTRACT ||
    plan.kind !== "campaign-source-rebind-plan"
  ) {
    throw new Error("macOS JIT source rebind plan contract is invalid");
  }
  const preflight = assertMacosJitSourceRebindPreflight(plan, profile);
  const runtimePlan = {
    ...plan,
    aws: { ...plan.aws, volumeId: preflight.resourceIds.volumeId },
  };
  let tagsUpdated = false;
  let refUpdated = false;
  try {
    setCampaignSourceTags(runtimePlan, profile, plan.source.sha);
    tagsUpdated = true;
    updateCampaignSourceRef(runtimePlan, plan.source.sha, false);
    refUpdated = true;
    assertReboundResources(runtimePlan, profile);
  } catch (error) {
    const rollbackFailures = [];
    const rollback = (operation) => {
      try {
        operation();
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError.message || String(rollbackError));
      }
    };
    if (refUpdated) {
      rollback(() =>
        updateCampaignSourceRef(runtimePlan, plan.previousSource.sha, true),
      );
    }
    if (tagsUpdated) {
      rollback(() =>
        setCampaignSourceTags(runtimePlan, profile, plan.previousSource.sha),
      );
    }
    const detail = rollbackFailures.length
      ? `; compensated rollback failed: ${rollbackFailures.join("; ")}`
      : "; compensated rollback completed";
    throw new Error(`${error.message || error}${detail}`);
  }
  return {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTROLLER_CONTRACT,
    kind: "campaign-source-rebind-result",
    status:
      plan.github.priorRunPolicy === "terminal-failure"
        ? "rebound-after-terminal-failure-zero-allocation"
        : plan.github.priorRunPolicy === "preflight-failure"
          ? "rebound-after-preflight-failure-zero-allocation"
          : "rebound-zero-allocation",
    repository: plan.repository,
    campaign: plan.campaign,
    previousSource: plan.previousSource,
    source: plan.source,
    github: {
      workflowId: plan.github.workflowId,
      workflowState: preflight.workflowState,
      sourceRefUpdated: true,
    },
    aws: {
      region: plan.aws.region,
      ...preflight.resourceIds,
      sourceTagsUpdated: true,
    },
    preflight,
    paidCapacityCreated: false,
    jobDispatched: false,
    planDigest: plan.digest,
  };
}
