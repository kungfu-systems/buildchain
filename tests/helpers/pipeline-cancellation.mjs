import assert from "node:assert/strict";
import { identities, runtime } from "./business-attempt.mjs";
import { atomicAttemptJournal } from "../../packages/core/workflow/attempt/journal.js";
import { pipelineProgress } from "../../packages/core/workflow/pipeline/progress.js";
import { pipelineMaterials } from "../../packages/core/workflow/pipeline/materials.js";
import {
  reconcilePipeline,
  pipelineCandidateRoot,
} from "../../packages/core/workflow/pipeline/reconcile.js";
import { materialDigest } from "../../packages/core/providers/github/discussions/materials.js";
import { createDeliveryWarrantService } from "../../packages/core/dev-delivery/warrant/service.js";
import {
  createDevDeliveryQueue,
  submitDevDeliveryCandidate,
  selectDevDeliveryWarrant,
  createNativeCommandContract,
  createNativeExecutionReceipt,
  createNativeQualificationProof,
  createNativeProofReuseDecision,
  qualifyDevDeliveryWarrant,
} from "../../packages/core/dev-delivery/dev-delivery-warrant.js";

const now = "2026-09-12T00:00:00Z";
const root = `sha256:${"a".repeat(64)}`;
function candidate(number, sourceHead) {
  return {
    pullRequestNumber: number,
    sourceHead,
    sourceRoot: root,
    sourceIdentityRoot: root,
    sourcePatchRoot: root,
    sourceProofRoot: root,
    planRoot: root,
    closureRoot: root,
    dependencyRoot: root,
    toolchainRoot: root,
    environmentRoot: root,
    nativeCommandContract: createNativeCommandContract("node --test"),
    deliveryClass: "native-proof-required",
    priority: "ordinary",
  };
}

function qualifiedQueue(queue, generation) {
  const warrant = queue.activeWarrant;
  const binding = {
    repository: warrant.repository,
    protectedBase: warrant.protectedBase,
    sourceHead: warrant.sourceHead,
    qualifiedBase: generation.baseCommit,
    nativeCommandRoot: warrant.nativeCommandContract.commandRoot,
    toolchainRoot: warrant.toolchainRoot,
    environmentRoot: warrant.environmentRoot,
  };
  const fields = {
    ...binding,
    sourceIdentityRoot: warrant.sourceIdentityRoot,
    sourcePatchRoot: warrant.sourcePatchRoot,
    planRoot: warrant.planRoot,
    closureRoot: warrant.closureRoot,
    dependencyRoot: warrant.dependencyRoot,
  };
  const proof = createNativeQualificationProof({
    ...fields,
    affectedPaths: ["package.json"],
    shardEvidenceRoots: [],
    qualifiedAt: now,
    nativeExecutionReceipt: createNativeExecutionReceipt({
      outcome: "succeeded",
      commandRoot: binding.nativeCommandRoot,
      executionBinding: binding,
      startedAt: now,
      completedAt: now,
      heartbeatCount: 1,
    }),
  });
  const current = {
    ...fields,
    currentBase: generation.baseCommit,
    graphKnown: true,
    attributionComplete: true,
    changedPaths: [],
    renames: [],
  };
  const reuseDecision = createNativeProofReuseDecision({ proof, current });
  return qualifyDevDeliveryWarrant(queue, warrant, {
    nativeProof: proof,
    reuseDecision,
    current,
    now,
  }).queue;
}

export async function cancellationFixture({ active = false } = {}) {
  const f = identities(["admission", "build", "review", "warrant", "merge"]);
  let snapshot,
    commit = 0;
  const journal = atomicAttemptJournal(
    {
      read: async () =>
        snapshot ? { snapshot, commit: String(commit) } : null,
      append: async (request) => {
        assert.equal(request.expectedCommit, commit ? String(commit) : "");
        snapshot = request.snapshot;
        commit++;
      },
    },
    f.intent,
  );
  const progress = pipelineProgress(journal, {
    intent: f.intent,
    runtime,
    writer: f.writer,
  });
  const opened = await progress.open(f.source, f.generation.baseCommit);
  for (const phase of ["admission", "build", "review"])
    await progress.progress({
      attempt: opened.attempt,
      phase,
      state: "success",
      eventKey: phase,
    });
  let queue = createDevDeliveryQueue({
    repository: f.intent.repository,
    protectedBase: f.intent.source.targetBranch,
    now,
  });
  const submit = (number, head) => {
    const value = candidate(number, head);
    if (number === 23)
      value.sourceRoot = pipelineCandidateRoot({
        ...opened.history.at(-1),
        intent: f.intent,
      });
    queue = submitDevDeliveryCandidate(queue, value, {
      now,
    }).queue;
  };
  if (!active) {
    submit(11, "1".repeat(40));
    queue = selectDevDeliveryWarrant(queue, { now }).queue;
  }
  submit(23, f.source.commit);
  if (active) queue = selectDevDeliveryWarrant(queue, { now }).queue;
  if (active) submit(24, "2".repeat(40));
  let writes = 0,
    lose = false;
  const domain = createDeliveryWarrantService(
    {
      repository: f.intent.repository,
      branch: f.intent.source.targetBranch,
      now,
    },
    {
      read: async () => ({
        queue: structuredClone(queue),
        commitSha: "b".repeat(40),
      }),
      write: async (request) => {
        assert.equal(request.expectedStateRoot, queue.stateRoot);
        queue = structuredClone(request.queue);
        writes++;
        return { commitSha: "c".repeat(40), stateRoot: queue.stateRoot };
      },
    },
  );
  const service = Object.fromEntries(
    ["cancelQueued", "settle"].map((name) => [
      name,
      async (request) => {
        const result = await domain[name](request);
        if (lose) {
          lose = false;
          throw new Error("Response lost after Warrant write");
        }
        return result;
      },
    ]),
  );
  const assets = new Map();
  const archive = {
    put: async (bytes) => {
      for (const [id, prior] of assets)
        if (prior.equals(bytes))
          return { id, size: bytes.length, digest: materialDigest(bytes) };
      const id = assets.size + 1;
      assets.set(id, bytes);
      return { id, size: bytes.length, digest: materialDigest(bytes) };
    },
    read: async ({ id }) => assets.get(id),
  };
  const materials = pipelineMaterials(archive, {
    repository: f.intent.repository,
    attempt: opened.history.at(-1).identity,
  });
  const live = {
    pullRequest: 23,
    source: f.source,
    baseCommit: f.generation.baseCommit,
    state: "closed",
    merged: false,
  };
  let worker = { status: "completed" },
    wakes = 0;
  const observe = async () => {
    const observed = await journal.read();
    const current = { ...observed.history.at(-1), intent: f.intent };
    const input = {
      current,
      live,
      queue: structuredClone(queue),
      worker,
      evidence: {},
    };
    return {
      ...input,
      decision: reconcilePipeline(input),
      attempt: observed.attempt,
      phase: observed.missing[0],
    };
  };
  return {
    journal,
    live,
    observe,
    queue: () => queue,
    qualify: () => {
      queue = qualifiedQueue(queue, f.generation);
    },
    writes: () => writes,
    wakes: () => wakes,
    lose: () => {
      lose = true;
    },
    running: () => {
      worker = { status: "in_progress" };
    },
    ports: {
      observe,
      progress,
      service,
      materials,
      wake: async () => {
        wakes++;
      },
    },
  };
}
