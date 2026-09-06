#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  cancelQueuedDevDeliveryCandidate,
  closeDevDeliveryWarrant,
  createDevDeliveryQueue,
  createNativeCommandContract,
  fenceDevDeliveryWriterProtocol,
  heartbeatDevDeliveryWarrant,
  observeDevDeliveryQueue,
  qualifyDevDeliveryWarrant,
  reconcileDevDeliveryTerminalEvidence,
  selectDevDeliveryWarrant,
  settleDevDeliveryTerminalEvent,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";
import { recoverLegacyTerminalDevDeliveryQueue } from "../packages/core/dev-delivery-warrant-legacy-recovery.js";
import { reuseExactActiveDevDeliverySourceProof } from "../packages/core/dev-delivery-candidate-identity.js";
import { runV4DeliveryWarrantReadCandidate } from "../packages/core/v4-delivery-warrant-read-candidate.js";

import { GitHubDevDeliveryStore } from "./dev-delivery-warrant-store.mjs";
import { persistDevDeliveryTransition } from "./dev-delivery-warrant-transition.mjs";
import { devDeliveryCliOptions } from "./dev-delivery-warrant-options.mjs";
export { GitHubDevDeliveryStore, devDeliveryCliOptions };

const STATE_REF_PREFIX = "buildchain/dev-delivery-warrant/";

function text(value = "") {
  return String(value ?? "").trim();
}
function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function positiveInteger(value, label, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function exactRoot(value, label) {
  const normalized = text(value).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized))
    throw new Error(`${label} must be a sha256 content root`);
  return normalized;
}

function exactSha(value, label) {
  const normalized = text(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized))
    throw new Error(`${label} must be a 40-character Git SHA`);
  return normalized;
}

function terminalSourceHead(options) {
  return exactSha(
    options.expectedSourceHead || options.sourceHead,
    "sourceHead",
  );
}

function reconcileTerminalEvidenceCommand(queue, options) {
  return reconcileDevDeliveryTerminalEvidence(
    queue,
    {
      candidateId: exactRoot(options.candidateId, "candidateId"),
      expectedPriorEvidenceRoot: exactRoot(
        options.expectedPriorEvidenceRoot,
        "expectedPriorEvidenceRoot",
      ),
      integrationProof:
        options.integrationProof ||
        jsonFile(options.integrationProofPath, "integration proof"),
      reason: options.reason,
    },
    { now: options.now },
  );
}

function requireTerminalEvidenceCas(options) {
  if (
    ["reconcile-terminal-evidence", "recover-legacy-terminal"].includes(
      options.command,
    ) &&
    options.execute &&
    !options.expectedOldStateRoot
  ) {
    throw new Error(
      "terminal evidence reconciliation execute requires expected-old CAS",
    );
  }
  if (
    options.command === "fence-writer-protocol" &&
    options.execute &&
    !options.expectedOldStateRoot
  ) {
    throw new Error("writer protocol fence execute requires expected-old CAS");
  }
}

function normalizeRepository(value) {
  const normalized = text(value);
  const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match)
    throw new Error(
      `repository must be owner/repo, got ${normalized || "<empty>"}`,
    );
  return { owner: match[1], repo: match[2], fullName: normalized };
}

function normalizeBranch(value) {
  const normalized = text(value).replace(/^refs\/heads\//, "");
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(normalized)) {
    throw new Error(
      `branch must be dev/vN/vN.M, got ${normalized || "<empty>"}`,
    );
  }
  return normalized;
}

export function defaultDevDeliveryStateRef(branch) {
  const normalized = normalizeBranch(branch);
  return `${STATE_REF_PREFIX}${normalized.replaceAll("/", "-")}`;
}

function normalizeStateRef(value, branch) {
  const normalized = text(value || defaultDevDeliveryStateRef(branch)).replace(
    /^refs\/heads\//,
    "",
  );
  if (
    !normalized.startsWith(STATE_REF_PREFIX) ||
    normalized.includes("..") ||
    normalized.endsWith("/")
  ) {
    throw new Error(`state ref must remain under ${STATE_REF_PREFIX}`);
  }
  return normalized;
}

function warrantIdentity(queue, options) {
  const active = queue.activeWarrant;
  if (!active) throw new Error("no active Delivery Warrant");
  const fencingToken = exactRoot(options.fencingToken, "fencingToken");
  const generation = positiveInteger(
    options.leaseGeneration,
    "leaseGeneration",
  );
  return { candidateId: active.candidateId, fencingToken, generation };
}

function jsonFile(file, label) {
  if (!file) throw new Error(`${label} is required`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function jsonList(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch (cause) {
    throw new Error(`${label} must be a JSON array: ${cause.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed;
}

function jsonObject(value, label) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (cause) {
    throw new Error(`${label} must be a JSON object: ${cause.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function transitionFor(command, queue, options) {
  if (command === "fence-writer-protocol") {
    return fenceDevDeliveryWriterProtocol(queue, { now: options.now });
  }
  if (command === "submit") {
    const nativeCommandContract = options.environmentRoot
      ? createNativeCommandContract(options.nativeCommand)
      : null;
    if (
      options.nativeCommandRoot &&
      nativeCommandContract?.commandRoot !==
        exactRoot(options.nativeCommandRoot, "nativeCommandRoot")
    ) {
      throw new Error(
        "native command contract root does not match native-command",
      );
    }
    const input = {
      pullRequestNumber: positiveInteger(
        options.pullRequestNumber,
        "pullRequestNumber",
      ),
      sourceHead: exactSha(options.sourceHead, "sourceHead"),
      ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}),
      ...(options.assignmentRoot
        ? { assignmentRoot: options.assignmentRoot }
        : {}),
      ...(options.initiativeRoot
        ? { initiativeRoot: options.initiativeRoot }
        : {}),
      sourceIdentityRoot: exactRoot(
        options.sourceIdentityRoot,
        "sourceIdentityRoot",
      ),
      sourcePatchRoot: exactRoot(options.sourcePatchRoot, "sourcePatchRoot"),
      sourceProofRoot: exactRoot(options.sourceProofRoot, "sourceProofRoot"),
      planRoot: exactRoot(options.planRoot, "planRoot"),
      closureRoot: exactRoot(options.closureRoot, "closureRoot"),
      dependencyRoot: exactRoot(options.dependencyRoot, "dependencyRoot"),
      toolchainRoot: exactRoot(options.toolchainRoot, "toolchainRoot"),
      ...(options.environmentRoot
        ? {
            environmentRoot: exactRoot(
              options.environmentRoot,
              "environmentRoot",
            ),
          }
        : {}),
      ...(nativeCommandContract ? { nativeCommandContract } : {}),
      affectedPaths: jsonList(options.affectedPaths, "affected paths"),
      shardEvidenceRoots: jsonList(
        options.shardEvidenceRoots,
        "shard evidence roots",
      ),
      sourceWorkflowRunId: options.sourceWorkflowRunId
        ? positiveInteger(options.sourceWorkflowRunId, "sourceWorkflowRunId")
        : 0,
      deliveryClass: options.deliveryClass,
      priority: options.priority || "ordinary",
      ...(options.releaseBlockerPriority
        ? {
            releaseBlockerPriority: jsonObject(
              options.releaseBlockerPriority,
              "release blocker priority",
            ),
          }
        : {}),
    };
    return submitDevDeliveryCandidate(
      queue,
      reuseExactActiveDevDeliverySourceProof(queue.activeWarrant, input),
      { now: options.now },
    );
  }
  if (command === "select") {
    return selectDevDeliveryWarrant(queue, {
      now: options.now,
      leaseSeconds: options.leaseSeconds,
    });
  }
  if (command === "heartbeat") {
    return heartbeatDevDeliveryWarrant(queue, warrantIdentity(queue, options), {
      now: options.now,
      leaseSeconds: options.leaseSeconds,
    });
  }
  if (command === "qualify") {
    return qualifyDevDeliveryWarrant(queue, warrantIdentity(queue, options), {
      nativeProof: jsonFile(options.nativeProofPath, "native proof"),
      reuseDecision: jsonFile(
        options.nativeReuseDecisionPath,
        "native reuse decision",
      ),
      current: {
        currentBase: options.currentBase,
        graphKnown: options.graphKnown,
        attributionComplete: options.attributionComplete,
        changedPaths: jsonList(options.changedPaths, "changed paths"),
        renames: jsonList(options.renames, "renames"),
      },
      now: options.now,
    });
  }
  if (command === "recover")
    return recoverExpiredDevDeliveryWarrant(queue, { now: options.now });
  if (command === "recover-legacy-terminal") {
    return recoverLegacyTerminalDevDeliveryQueue(
      queue,
      jsonFile(options.legacyTerminalRecoveryPath, "legacy terminal recovery"),
      { now: options.now },
    );
  }
  if (command === "close") {
    return closeDevDeliveryWarrant(queue, warrantIdentity(queue, options), {
      outcome: options.outcome,
      evidenceRoot: exactRoot(options.evidenceRoot, "evidenceRoot"),
      reason: options.reason,
      now: options.now,
    });
  }
  if (command === "settle") {
    return settleDevDeliveryTerminalEvent(
      queue,
      {
        pullRequestNumber: positiveInteger(
          options.pullRequestNumber,
          "pullRequestNumber",
        ),
        sourceHead: terminalSourceHead(options),
        fencingToken: options.fencingToken,
        leaseGeneration: options.leaseGeneration,
        outcome: options.outcome,
        eventAction: options.eventAction,
        evidenceRoot: options.evidenceRoot,
        reason: options.reason,
        transferRoot: options.transferRoot,
        finalizerBoundaryRoot: options.finalizerBoundaryRoot,
        nativeJobId: options.nativeJobId,
        sealJobId: options.sealJobId,
      },
      { now: options.now },
    );
  }
  if (command === "reconcile-terminal-evidence") {
    return reconcileTerminalEvidenceCommand(queue, options);
  }
  if (command === "cancel-queued") {
    return cancelQueuedDevDeliveryCandidate(
      queue,
      {
        candidateId: exactRoot(options.candidateId, "candidateId"),
        pullRequestNumber: positiveInteger(
          options.pullRequestNumber,
          "pullRequestNumber",
        ),
        expectedSourceHead: exactSha(
          options.expectedSourceHead,
          "expectedSourceHead",
        ),
        observedSourceHead: exactSha(
          options.observedSourceHead,
          "observedSourceHead",
        ),
        eventAction: options.eventAction,
        outcome: options.outcome,
        evidenceRoot: exactRoot(options.evidenceRoot, "evidenceRoot"),
        reason: options.reason,
      },
      { now: options.now },
    );
  }
  throw new Error(`unsupported dev delivery command ${command || "<empty>"}`);
}

async function observeQueue(loaded, options) {
  const readMode = text(options.readMode || "v3").toLowerCase();
  if (!["v3", "v4"].includes(readMode))
    throw new Error("readMode must be v3 or v4");
  let observation = observeDevDeliveryQueue(loaded.queue, {
    now: options.now,
    allowLegacyV3Readback: true,
  });
  let readCandidate;
  if (readMode === "v4") {
    const qualification =
      options.readQualification ||
      JSON.parse(fs.readFileSync(options.readQualificationPath, "utf8"));
    const retain =
      options.retainReadEvidence ||
      (async (evidence) => {
        if (!options.readEvidenceOutput)
          throw new Error("readEvidenceOutput is required");
        fs.mkdirSync(path.dirname(options.readEvidenceOutput), {
          recursive: true,
        });
        fs.writeFileSync(
          options.readEvidenceOutput,
          `${JSON.stringify(evidence, null, 2)}\n`,
        );
        return { receiptRoot: evidence.evidenceRoot };
      });
    readCandidate = await runV4DeliveryWarrantReadCandidate(loaded.queue, {
      qualification,
      expectedQualificationRoot: options.readQualificationRoot,
      expectedSources: {
        typescriptRevision: options.readTypescriptRevision,
        rustRevision: options.readRustRevision,
        validatorVersion: options.readValidatorVersion,
      },
      observedAt: options.now,
      timeoutMs: positiveInteger(options.readTimeoutMs, "readTimeoutMs", 5_000),
      signal: options.readSignal,
      invokeRust: options.invokeV4ReadHost,
      host: options.readHost,
      retain,
    });
    observation = readCandidate.observation;
  }
  return {
    schema: "kungfu.buildchain.dev-delivery-command-result/v1",
    ok: true,
    mode: "observe",
    readMode,
    stateRef: options.stateRef,
    stateCommit: loaded.commitSha,
    observation,
    ...(readCandidate ? { readCandidate } : {}),
  };
}

export async function runDevDeliveryCommand(optionsInput = {}, clientInput) {
  const options = {
    ...optionsInput,
    repository: normalizeRepository(optionsInput.repository).fullName,
    branch: normalizeBranch(optionsInput.branch),
    stateRef: normalizeStateRef(optionsInput.stateRef, optionsInput.branch),
    now: new Date(optionsInput.now || Date.now()).toISOString(),
    execute: bool(optionsInput.execute, false),
  };
  requireTerminalEvidenceCas(options);
  if (
    options.command === "submit" &&
    options.execute &&
    options.deliveryClass !== "non-native-fast"
  ) {
    exactRoot(options.environmentRoot, "environmentRoot");
  }
  const store =
    clientInput ||
    new GitHubDevDeliveryStore({
      repository: options.repository,
      token: options.token || process.env.GITHUB_TOKEN,
      apiUrl:
        options.apiUrl ||
        process.env.GITHUB_API_URL ||
        "https://api.github.com",
    });
  let loaded = await store.read({
    stateRef: options.stateRef,
    protectedBase: options.branch,
    now: options.now,
    allowLegacyV3Readback: ["observe", "recover-legacy-terminal"].includes(
      options.command,
    ),
  });
  let concurrencyRecovery = null;
  if (
    options.expectedOldStateRoot &&
    loaded.queue.stateRoot !== options.expectedOldStateRoot
  ) {
    if (options.command !== "heartbeat") {
      throw new Error(
        `expected-old state drift: ${loaded.queue.stateRoot} != ${options.expectedOldStateRoot}`,
      );
    }
    concurrencyRecovery = {
      schema: "kungfu.buildchain.dev-delivery-concurrency-recovery/v1",
      action: "heartbeat-state-root-rebased",
      requestedStateRoot: options.expectedOldStateRoot,
      observedStateRoot: loaded.queue.stateRoot,
      observedCommitSha: loaded.commitSha,
    };
  }
  if (options.command === "observe") return observeQueue(loaded, options);
  const initialLoaded = loaded;
  const persisted = await persistDevDeliveryTransition({
    store,
    options,
    loaded,
    initialLoaded,
    changed: transitionFor(options.command, loaded.queue, options),
    transitionFor,
  });
  loaded = persisted.loaded;
  concurrencyRecovery = persisted.concurrencyRecovery || concurrencyRecovery;
  return {
    schema: "kungfu.buildchain.dev-delivery-command-result/v1",
    ok: true,
    mode: options.execute ? "execute" : "plan",
    command: options.command,
    stateRef: options.stateRef,
    before: { commitSha: loaded.commitSha, stateRoot: loaded.queue.stateRoot },
    after: {
      commitSha: persisted.write?.commitSha || loaded.commitSha,
      stateRoot: persisted.changed.queue.stateRoot,
    },
    mutationAuthorized: options.execute,
    mutationApplied: Boolean(persisted.write),
    concurrencyRecovery,
    receipt: persisted.changed.receipt,
    receiptRoot: persisted.changed.receiptRoot,
    warrant:
      persisted.changed.warrant ||
      persisted.changed.queue.activeWarrant ||
      null,
    observation: observeDevDeliveryQueue(persisted.changed.queue, {
      now: options.now,
    }),
  };
}

function usage() {
  return "Usage:\n  buildchain dev warrant <fence-writer-protocol|submit|select|heartbeat|qualify|recover|recover-legacy-terminal|close|settle|reconcile-terminal-evidence|cancel-queued|observe> --repository owner/repo --branch dev/vN/vN.M [--execute] [--output FILE] [--json]\n\nWriter protocol fence:\n  fence-writer-protocol --expected-old sha256:... [--execute]\n\nLegacy terminal recovery:\n  recover-legacy-terminal --expected-old sha256:... --legacy-terminal-recovery FILE [--execute]\n\nRead candidate:\n  observe --read-mode v4 --read-qualification FILE --read-qualification-root sha256:... --read-typescript-revision SHA --read-rust-revision SHA --read-validator-version TOKEN [--read-evidence-output FILE]\n";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    process.stdout.write(usage());
    return;
  }
  const options = devDeliveryCliOptions(args);
  if (
    ![
      "fence-writer-protocol",
      "submit",
      "select",
      "heartbeat",
      "qualify",
      "recover",
      "recover-legacy-terminal",
      "close",
      "settle",
      "reconcile-terminal-evidence",
      "cancel-queued",
      "observe",
    ].includes(options.command)
  ) {
    throw new Error(usage().trim());
  }
  const result = await runDevDeliveryCommand(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  if (options.json)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `Buildchain dev delivery ${options.command}: ${result.receipt?.reason || result.mode}\n`,
    );
    process.stdout.write(
      `State root: ${result.after?.stateRoot || result.observation.stateRoot}\n`,
    );
    if (result.receiptRoot)
      process.stdout.write(`Receipt root: ${result.receiptRoot}\n`);
    process.stdout.write(`Result: ${options.outputPath}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`buildchain dev warrant: ${error.message}`);
    process.exit(1);
  });
}
