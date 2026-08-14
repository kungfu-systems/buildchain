import fs from "node:fs";

import {
  createNativeProofReuseDecision,
  verifyProjectCutReplayProof,
} from "../packages/core/dev-delivery-warrant.js";

function mismatch(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  throw error;
}

function readOptionalJson(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function attributedBaseDelta(data, previousBase) {
  const files = Array.isArray(data?.files) ? data.files : [];
  const graphKnown =
    data?.status === "ahead" &&
    data?.merge_base_commit?.sha === previousBase &&
    files.length < 300;
  const renames = files
    .filter((entry) => entry.status === "renamed")
    .map((entry) => ({
      from: String(entry.previous_filename || ""),
      to: String(entry.filename || ""),
    }));
  const attributionComplete =
    graphKnown &&
    files.every((entry) => String(entry.filename || "")) &&
    renames.every((entry) => entry.from && entry.to);
  return {
    graphKnown,
    attributionComplete,
    changedPaths: attributionComplete
      ? [
          ...new Set(
            files
              .flatMap((entry) => [
                String(entry.filename || ""),
                String(entry.previous_filename || ""),
              ])
              .filter(Boolean),
          ),
        ].sort()
      : [],
    renames: attributionComplete ? renames : [],
  };
}

function reuseFailure(decision) {
  if (decision.reason === "base-delta-overlaps-affected-closure") {
    return "pre-enqueue-base-delta-overlap";
  }
  if (
    [
      "base-delta-attribution-unknown",
      "affected-closure-paths-unknown",
    ].includes(decision.reason)
  ) {
    return "pre-enqueue-base-attribution-unknown";
  }
  return "pre-enqueue-native-proof-drift";
}

async function githubBaseDelta(
  client,
  options,
  previousBaseSha,
  currentBaseSha,
) {
  if (typeof client.getBaseDelta === "function") {
    return client.getBaseDelta(previousBaseSha, currentBaseSha);
  }
  const { data } = await client.request(
    "GET",
    `/repos/${options.repository.owner}/${options.repository.repo}/compare/${previousBaseSha}...${currentBaseSha}`,
  );
  return data;
}

async function githubCommitTree(client, options, mergeCommitSha) {
  if (typeof client.getCommitTree === "function") {
    return client.getCommitTree(mergeCommitSha);
  }
  const { data } = await client.request(
    "GET",
    `/repos/${options.repository.owner}/${options.repository.repo}/git/commits/${mergeCommitSha}`,
  );
  return String(data?.tree?.sha || "").toLowerCase();
}

export async function projectCutQualification(pr, options, client) {
  if (!options.projectCutProofPath) {
    return { ok: false, reason: "project-cut-proof-required" };
  }
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(options.projectCutProofPath, "utf8"));
  } catch {
    return { ok: false, reason: "project-cut-proof-invalid" };
  }
  const currentBase = await client
    .getBranchSha(options.targetBranch)
    .catch(() => "");
  const verification = verifyProjectCutReplayProof(proof, {
    repository: options.repository.fullName,
    protectedBase: options.targetBranch,
    pullRequestNumber: Number(pr.number),
    sourceHead: String(pr.head?.sha || "").toLowerCase(),
    ...(options.sourcePatchRoot
      ? { sourcePatchRoot: options.sourcePatchRoot }
      : {}),
    currentBase,
  });
  return verification.ok
    ? {
        ok: true,
        reason: verification.reason,
        proofRoot: verification.proofRoot,
        currentBase,
      }
    : {
        ok: false,
        reason: `project-cut-${verification.reason}`,
        currentBase,
      };
}

async function qualifyProjectCut({
  client,
  options,
  pullRequest,
  previousBaseSha,
  currentBaseSha,
  expectedHeadSha,
  observedPullRequest,
  projectCut,
  mergeableAccepted,
  root,
}) {
  const observedHeadSha = String(
    observedPullRequest.head?.sha || "",
  ).toLowerCase();
  if (observedHeadSha !== expectedHeadSha) {
    mismatch("head-sha-drift-after-lease-readback", { observedHeadSha });
  }
  if (observedPullRequest.mergeable === false) {
    mismatch("pre-enqueue-merge-conflict");
  }
  if (
    !mergeableAccepted(observedPullRequest, "queue", projectCut?.ok === true)
  ) {
    mismatch("not-mergeable-after-latest-base-replay");
  }

  let reuseDecision = null;
  if (currentBaseSha !== previousBaseSha) {
    const proof = readOptionalJson(options.nativeProofPath);
    if (!proof) mismatch("pre-enqueue-base-attribution-unknown");
    let delta;
    try {
      delta = attributedBaseDelta(
        await githubBaseDelta(client, options, previousBaseSha, currentBaseSha),
        previousBaseSha,
      );
    } catch {
      mismatch("pre-enqueue-base-attribution-unknown");
    }
    reuseDecision = createNativeProofReuseDecision({
      proof,
      current: {
        sourceHead: expectedHeadSha,
        sourceIdentityRoot: proof.sourceIdentityRoot,
        sourcePatchRoot: proof.sourcePatchRoot,
        planRoot: proof.planRoot,
        closureRoot: proof.closureRoot,
        dependencyRoot: proof.dependencyRoot,
        toolchainRoot: proof.toolchainRoot,
        environmentRoot: proof.environmentRoot,
        currentBase: currentBaseSha,
        graphKnown: delta.graphKnown,
        attributionComplete: delta.attributionComplete,
        changedPaths: delta.changedPaths,
        renames: delta.renames,
      },
    });
    if (!reuseDecision.reusable) {
      mismatch(reuseFailure(reuseDecision), { reuseDecision });
    }
  }

  const mergeCommitSha = String(
    observedPullRequest.merge_commit_sha || "",
  ).toLowerCase();
  const replayTree = /^[0-9a-f]{40}$/u.test(mergeCommitSha)
    ? await githubCommitTree(client, options, mergeCommitSha).catch(() => "")
    : "";
  if (
    currentBaseSha !== previousBaseSha &&
    (!/^[0-9a-f]{40}$/u.test(mergeCommitSha) ||
      !/^[0-9a-f]{40}$/u.test(replayTree))
  ) {
    mismatch("pre-enqueue-project-cut-composition-missing", {
      mergeCommitSha,
      replayTree,
    });
  }
  const receipt = {
    schema: "kungfu.buildchain.pre-enqueue-project-cut/v1",
    repository: options.repository.fullName,
    protectedBase: options.targetBranch,
    pullRequestNumber: pullRequest.number,
    sourceHead: expectedHeadSha,
    previousBase: previousBaseSha,
    admittedBase: currentBaseSha,
    baseMoved: currentBaseSha !== previousBaseSha,
    sourceHeadMutationRequired: false,
    composition: { mergeCommitSha, replayTree },
    nativeProofReuseDecisionRoot: reuseDecision?.decisionRoot || "",
    projectCutProofRoot: projectCut?.proofRoot || "",
    decision: "qualified",
  };
  return { receipt, receiptRoot: root(receipt) };
}

function exactQueueEntry(queueState, pullRequest, expectedHeadSha) {
  return queueState.entries.find(
    (candidate) =>
      candidate.pullRequestNumber === pullRequest.number &&
      candidate.pullRequestHeadSha === expectedHeadSha,
  );
}

export async function qualifyPreEnqueueReadback({
  client,
  options,
  pullRequest,
  expectedBaseSha,
  expectedHeadSha,
  projectCut,
  mergeableAccepted,
  root,
  verifyCurrentWarrant,
}) {
  const [
    observedPullRequest,
    observedBaseSha,
    observedQueueState,
    currentWarrant,
  ] = await Promise.all([
    client.getPullRequest(pullRequest.number, {
      attempts: options.pollMergeableAttempts,
      delayMs: options.pollMergeableDelayMs,
    }),
    client.getBranchSha(options.targetBranch),
    client.getMergeQueueState(options.targetBranch),
    verifyCurrentWarrant(
      client,
      options,
      pullRequest,
      options.verifiedDeliveryWarrant,
    ),
  ]);
  const observedHeadSha = String(
    observedPullRequest.head?.sha || "",
  ).toLowerCase();
  if (observedHeadSha !== expectedHeadSha) {
    mismatch("head-sha-drift-after-lease-readback", { observedHeadSha });
  }
  if (options.warrantMode !== "required") {
    if (observedBaseSha !== expectedBaseSha) {
      mismatch("base-sha-drift-after-lease-readback", { observedBaseSha });
    }
    if (
      !mergeableAccepted(observedPullRequest, "queue", projectCut?.ok === true)
    ) {
      mismatch("not-mergeable-after-lease-readback");
    }
    return {
      observedBaseSha,
      observedQueueState,
      currentWarrant,
      preEnqueueProjectCut: null,
    };
  }

  const preEnqueueProjectCut = await qualifyProjectCut({
    client,
    options,
    pullRequest,
    previousBaseSha: expectedBaseSha,
    currentBaseSha: observedBaseSha,
    expectedHeadSha,
    observedPullRequest,
    projectCut,
    mergeableAccepted,
    root,
  });
  const [casPullRequest, casBaseSha, casQueueState, casWarrant] =
    await Promise.all([
      client.getPullRequest(pullRequest.number, {
        attempts: options.pollMergeableAttempts,
        delayMs: options.pollMergeableDelayMs,
      }),
      client.getBranchSha(options.targetBranch),
      client.getMergeQueueState(options.targetBranch),
      verifyCurrentWarrant(
        client,
        options,
        pullRequest,
        options.verifiedDeliveryWarrant,
      ),
    ]);
  if (casBaseSha !== observedBaseSha) {
    mismatch("base-sha-drift-after-project-cut", {
      observedBaseSha: casBaseSha,
    });
  }
  if (
    String(casPullRequest.head?.sha || "").toLowerCase() !== expectedHeadSha
  ) {
    mismatch("head-sha-drift-after-project-cut");
  }
  if (casPullRequest.mergeable === false) {
    mismatch("pre-enqueue-merge-conflict-after-project-cut");
  }
  if (!mergeableAccepted(casPullRequest, "queue", projectCut?.ok === true)) {
    mismatch("not-mergeable-after-project-cut");
  }
  const casMergeCommitSha = String(
    casPullRequest.merge_commit_sha || "",
  ).toLowerCase();
  if (
    casMergeCommitSha !==
    preEnqueueProjectCut.receipt.composition.mergeCommitSha
  ) {
    mismatch("pre-enqueue-project-cut-composition-drift", {
      observedMergeCommitSha: casMergeCommitSha,
    });
  }
  if (preEnqueueProjectCut.receipt.composition.replayTree) {
    const casReplayTree = await githubCommitTree(
      client,
      options,
      casMergeCommitSha,
    ).catch(() => "");
    if (casReplayTree !== preEnqueueProjectCut.receipt.composition.replayTree) {
      mismatch("pre-enqueue-project-cut-composition-drift", {
        observedReplayTree: casReplayTree,
      });
    }
  }
  const exactEntry = exactQueueEntry(
    casQueueState,
    pullRequest,
    expectedHeadSha,
  );
  const predecessor =
    casQueueState.entries.find((candidate) => candidate !== exactEntry) || null;
  if (predecessor) {
    mismatch("queue-predecessor-after-project-cut", { predecessor });
  }
  return {
    observedBaseSha,
    observedQueueState: casQueueState,
    currentWarrant: casWarrant,
    preEnqueueProjectCut,
  };
}
