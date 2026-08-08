#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { cancelQueuedDevDeliveryCandidate, closeDevDeliveryWarrant, createDevDeliveryQueue, heartbeatDevDeliveryWarrant, observeDevDeliveryQueue, recoverExpiredDevDeliveryWarrant, selectDevDeliveryWarrant, settleDevDeliveryTerminalEvent, submitDevDeliveryCandidate } from "../packages/core/dev-delivery-warrant.js";
import { runV4DeliveryWarrantReadCandidate } from "../packages/core/v4-delivery-warrant-read-candidate.js";

const STATE_PATH = "queue.json";
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
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function exactRoot(value, label) {
  const normalized = text(value).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a sha256 content root`);
  return normalized;
}

function exactSha(value, label) {
  const normalized = text(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} must be a 40-character Git SHA`);
  return normalized;
}

function normalizeRepository(value) {
  const normalized = text(value);
  const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`repository must be owner/repo, got ${normalized || "<empty>"}`);
  return { owner: match[1], repo: match[2], fullName: normalized };
}

function normalizeBranch(value) {
  const normalized = text(value).replace(/^refs\/heads\//, "");
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(normalized)) {
    throw new Error(`branch must be dev/vN/vN.M, got ${normalized || "<empty>"}`);
  }
  return normalized;
}

export function defaultDevDeliveryStateRef(branch) {
  const normalized = normalizeBranch(branch);
  return `${STATE_REF_PREFIX}${normalized.replaceAll("/", "-")}`;
}

function normalizeStateRef(value, branch) {
  const normalized = text(value || defaultDevDeliveryStateRef(branch)).replace(/^refs\/heads\//, "");
  if (!normalized.startsWith(STATE_REF_PREFIX) || normalized.includes("..") || normalized.endsWith("/")) {
    throw new Error(`state ref must remain under ${STATE_REF_PREFIX}`);
  }
  return normalized;
}

function encodeRef(ref) {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function decodeBlob(blob) {
  if (blob.encoding !== "base64") throw new Error(`unsupported Git blob encoding ${blob.encoding || "<empty>"}`);
  return Buffer.from(String(blob.content || "").replace(/\s+/g, ""), "base64").toString("utf8");
}

export class GitHubDevDeliveryStore {
  constructor({ repository, token, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch } = {}) {
    this.repository = normalizeRepository(repository);
    if (!fetchImpl) throw new Error("fetch is required");
    if (!token) throw new Error("GITHUB_TOKEN is required for the GitHub dev delivery store");
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
  }

  async request(method, requestPath, body) {
    const response = await this.fetch(`${this.apiUrl}${requestPath}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!response.ok) {
      const error = new Error(data?.message || raw || `${method} ${requestPath} failed`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async read({ stateRef, protectedBase, now }) {
    let ref;
    try {
      ref = await this.request("GET", `/repos/${this.repository.fullName}/git/ref/heads/${encodeRef(stateRef)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      return {
        exists: false,
        commitSha: "",
        queue: createDevDeliveryQueue({
          repository: this.repository.fullName,
          protectedBase,
          now,
        }),
      };
    }
    const commitSha = exactSha(ref?.object?.sha, "state ref commit");
    const readback = await this.readCommit(commitSha);
    return { exists: true, ...readback };
  }

  async readCommit(commitShaInput) {
    const commitSha = exactSha(commitShaInput, "state commit");
    const commit = await this.request("GET", `/repos/${this.repository.fullName}/git/commits/${commitSha}`);
    const tree = await this.request("GET", `/repos/${this.repository.fullName}/git/trees/${commit.tree?.sha}`);
    const entry = (tree.tree || []).find((item) => item.path === STATE_PATH && item.type === "blob");
    if (!entry?.sha) throw new Error(`${commitSha} does not contain ${STATE_PATH}`);
    const blob = await this.request("GET", `/repos/${this.repository.fullName}/git/blobs/${entry.sha}`);
    const queue = JSON.parse(decodeBlob(blob));
    return { commitSha, queue };
  }

  async write({ stateRef, queue, expectedCommitSha, expectedStateRoot, receiptRoot }) {
    if (queue.stateRoot === expectedStateRoot) throw new Error("state transition did not advance the queue root");
    const blob = await this.request("POST", `/repos/${this.repository.fullName}/git/blobs`, {
      content: `${JSON.stringify(queue, null, 2)}\n`,
      encoding: "utf-8",
    });
    const tree = await this.request("POST", `/repos/${this.repository.fullName}/git/trees`, {
      tree: [{ path: STATE_PATH, mode: "100644", type: "blob", sha: blob.sha }],
    });
    const commit = await this.request("POST", `/repos/${this.repository.fullName}/git/commits`, {
      message: `chore(dev-delivery): advance Warrant queue ${receiptRoot.slice(0, 20)}`,
      tree: tree.sha,
      parents: expectedCommitSha ? [expectedCommitSha] : [],
    });
    if (expectedCommitSha) {
      await this.request("PATCH", `/repos/${this.repository.fullName}/git/refs/heads/${encodeRef(stateRef)}`, { sha: commit.sha, force: false });
    } else {
      await this.request("POST", `/repos/${this.repository.fullName}/git/refs`, {
        ref: `refs/heads/${stateRef}`,
        sha: commit.sha,
      });
    }
    const readback = await this.readCommit(commit.sha);
    if (readback.commitSha !== commit.sha || readback.queue.stateRoot !== queue.stateRoot) {
      throw new Error("dev delivery state commit readback mismatch after expected-old update");
    }
    return { commitSha: commit.sha, stateRoot: readback.queue.stateRoot };
  }
}

function warrantIdentity(queue, options) {
  const active = queue.activeWarrant;
  if (!active) throw new Error("no active Delivery Warrant");
  const fencingToken = exactRoot(options.fencingToken, "fencingToken");
  const generation = positiveInteger(options.leaseGeneration, "leaseGeneration");
  return { candidateId: active.candidateId, fencingToken, generation };
}

function transitionFor(command, queue, options) {
  if (command === "submit") {
    return submitDevDeliveryCandidate(
      queue,
      {
        pullRequestNumber: positiveInteger(options.pullRequestNumber, "pullRequestNumber"),
        sourceHead: exactSha(options.sourceHead, "sourceHead"),
        assignmentRoot: exactRoot(options.assignmentRoot, "assignmentRoot"),
        initiativeRoot: exactRoot(options.initiativeRoot, "initiativeRoot"),
        sourceIdentityRoot: exactRoot(options.sourceIdentityRoot, "sourceIdentityRoot"),
        sourcePatchRoot: exactRoot(options.sourcePatchRoot, "sourcePatchRoot"),
        sourceProofRoot: exactRoot(options.sourceProofRoot, "sourceProofRoot"),
        planRoot: exactRoot(options.planRoot, "planRoot"),
        closureRoot: exactRoot(options.closureRoot, "closureRoot"),
        dependencyRoot: exactRoot(options.dependencyRoot, "dependencyRoot"),
        toolchainRoot: exactRoot(options.toolchainRoot, "toolchainRoot"),
        deliveryClass: options.deliveryClass,
        priority: options.priority || "ordinary",
      },
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
  if (command === "recover") return recoverExpiredDevDeliveryWarrant(queue, { now: options.now });
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
        pullRequestNumber: positiveInteger(options.pullRequestNumber, "pullRequestNumber"),
        sourceHead: exactSha(options.expectedSourceHead || options.sourceHead, "sourceHead"),
        fencingToken: options.fencingToken,
        leaseGeneration: options.leaseGeneration,
        outcome: options.outcome,
        eventAction: options.eventAction,
        evidenceRoot: options.evidenceRoot,
        reason: options.reason,
      },
      { now: options.now },
    );
  }
  if (command === "cancel-queued") {
    return cancelQueuedDevDeliveryCandidate(
      queue,
      {
        candidateId: exactRoot(options.candidateId, "candidateId"),
        pullRequestNumber: positiveInteger(options.pullRequestNumber, "pullRequestNumber"),
        expectedSourceHead: exactSha(options.expectedSourceHead, "expectedSourceHead"),
        observedSourceHead: exactSha(options.observedSourceHead, "observedSourceHead"),
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
  if (!["v3", "v4"].includes(readMode)) throw new Error("readMode must be v3 or v4");
  let observation = observeDevDeliveryQueue(loaded.queue, { now: options.now });
  let readCandidate;
  if (readMode === "v4") {
    const qualification = options.readQualification || JSON.parse(fs.readFileSync(options.readQualificationPath, "utf8"));
    const retain =
      options.retainReadEvidence ||
      (async (evidence) => {
        if (!options.readEvidenceOutput) throw new Error("readEvidenceOutput is required");
        fs.mkdirSync(path.dirname(options.readEvidenceOutput), { recursive: true });
        fs.writeFileSync(options.readEvidenceOutput, `${JSON.stringify(evidence, null, 2)}\n`);
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
  const store =
    clientInput ||
    new GitHubDevDeliveryStore({
      repository: options.repository,
      token: options.token || process.env.GITHUB_TOKEN,
      apiUrl: options.apiUrl || process.env.GITHUB_API_URL || "https://api.github.com",
    });
  let loaded = await store.read({
    stateRef: options.stateRef,
    protectedBase: options.branch,
    now: options.now,
  });
  if (options.expectedOldStateRoot && loaded.queue.stateRoot !== options.expectedOldStateRoot) {
    throw new Error(`expected-old state drift: ${loaded.queue.stateRoot} != ${options.expectedOldStateRoot}`);
  }
  if (options.command === "observe") return observeQueue(loaded, options);
  const initialLoaded = loaded;
  let changed = transitionFor(options.command, loaded.queue, options);
  let mutates = changed.queue.stateRoot !== loaded.queue.stateRoot;
  let write = null;
  let concurrencyRecovery = null;
  if (options.execute && mutates) {
    if (changed.receipt.expectedOldStateRoot !== loaded.queue.stateRoot) {
      throw new Error("transition receipt expected-old root does not match the loaded authority");
    }
    try {
      write = await store.write({
        stateRef: options.stateRef,
        queue: changed.queue,
        expectedCommitSha: loaded.commitSha,
        expectedStateRoot: loaded.queue.stateRoot,
        receiptRoot: changed.receiptRoot,
      });
    } catch (error) {
      if (options.command !== "settle" || options.expectedOldStateRoot) throw error;
      const latest = await store.read({
        stateRef: options.stateRef,
        protectedBase: options.branch,
        now: options.now,
      });
      const reconciled = transitionFor(options.command, latest.queue, options);
      const reconciledMutates = reconciled.queue.stateRoot !== latest.queue.stateRoot;
      if (reconciledMutates || reconciled.receipt.action !== "duplicate-terminal-event-noop") throw error;
      loaded = latest;
      changed = reconciled;
      mutates = false;
      concurrencyRecovery = {
        schema: "kungfu.buildchain.dev-delivery-concurrency-recovery/v1",
        action: "terminal-settlement-race-noop",
        initialCommitSha: initialLoaded.commitSha,
        observedCommitSha: latest.commitSha,
        observedStateRoot: latest.queue.stateRoot,
      };
    }
  }
  return {
    schema: "kungfu.buildchain.dev-delivery-command-result/v1",
    ok: true,
    mode: options.execute ? "execute" : "plan",
    command: options.command,
    stateRef: options.stateRef,
    before: { commitSha: loaded.commitSha, stateRoot: loaded.queue.stateRoot },
    after: {
      commitSha: write?.commitSha || loaded.commitSha,
      stateRoot: changed.queue.stateRoot,
    },
    mutationAuthorized: options.execute,
    mutationApplied: Boolean(write),
    concurrencyRecovery,
    receipt: changed.receipt,
    receiptRoot: changed.receiptRoot,
    warrant: changed.warrant || changed.queue.activeWarrant || null,
    observation: observeDevDeliveryQueue(changed.queue, { now: options.now }),
  };
}

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

export function devDeliveryCliOptions(args = [], environment = process.env) {
  const [command = "", ...rest] = args;
  return {
    command,
    repository: flag(rest, "repository", environment.GITHUB_REPOSITORY),
    branch: flag(rest, "branch", environment.BUILDCHAIN_DEV_DELIVERY_BRANCH || environment.GITHUB_BASE_REF),
    stateRef: flag(rest, "state-ref", environment.BUILDCHAIN_DEV_DELIVERY_STATE_REF),
    expectedOldStateRoot: flag(rest, "expected-old", environment.BUILDCHAIN_DEV_DELIVERY_EXPECTED_OLD),
    pullRequestNumber: flag(rest, "pull-request", environment.BUILDCHAIN_DEV_DELIVERY_PR_NUMBER),
    candidateId: flag(rest, "candidate-id", environment.BUILDCHAIN_DEV_DELIVERY_CANDIDATE_ID),
    sourceHead: flag(rest, "source-head", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_HEAD),
    expectedSourceHead: flag(rest, "expected-source-head", environment.BUILDCHAIN_DEV_DELIVERY_EXPECTED_SOURCE_HEAD),
    observedSourceHead: flag(rest, "observed-source-head", environment.BUILDCHAIN_DEV_DELIVERY_OBSERVED_SOURCE_HEAD),
    assignmentRoot: flag(rest, "assignment-root", environment.BUILDCHAIN_DEV_DELIVERY_ASSIGNMENT_ROOT),
    initiativeRoot: flag(rest, "initiative-root", environment.BUILDCHAIN_DEV_DELIVERY_INITIATIVE_ROOT),
    sourceIdentityRoot: flag(rest, "source-identity-root", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_IDENTITY_ROOT),
    sourcePatchRoot: flag(rest, "source-patch-root", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PATCH_ROOT),
    sourceProofRoot: flag(rest, "source-proof-root", environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PROOF_ROOT),
    planRoot: flag(rest, "plan-root", environment.BUILDCHAIN_DEV_DELIVERY_PLAN_ROOT),
    closureRoot: flag(rest, "closure-root", environment.BUILDCHAIN_DEV_DELIVERY_CLOSURE_ROOT),
    dependencyRoot: flag(rest, "dependency-root", environment.BUILDCHAIN_DEV_DELIVERY_DEPENDENCY_ROOT),
    toolchainRoot: flag(rest, "toolchain-root", environment.BUILDCHAIN_DEV_DELIVERY_TOOLCHAIN_ROOT),
    deliveryClass: flag(rest, "delivery-class", environment.BUILDCHAIN_DEV_DELIVERY_CLASS),
    priority: flag(rest, "priority", environment.BUILDCHAIN_DEV_DELIVERY_PRIORITY || "ordinary"),
    fencingToken: flag(rest, "fencing-token", environment.BUILDCHAIN_DEV_DELIVERY_FENCING_TOKEN),
    leaseGeneration: flag(rest, "lease-generation", environment.BUILDCHAIN_DEV_DELIVERY_LEASE_GENERATION),
    leaseSeconds: flag(rest, "lease-seconds", environment.BUILDCHAIN_DEV_DELIVERY_LEASE_SECONDS),
    outcome: flag(rest, "outcome", environment.BUILDCHAIN_DEV_DELIVERY_OUTCOME),
    eventAction: flag(rest, "event-action", environment.BUILDCHAIN_DEV_DELIVERY_EVENT_ACTION),
    evidenceRoot: flag(rest, "evidence-root", environment.BUILDCHAIN_DEV_DELIVERY_EVIDENCE_ROOT),
    reason: flag(rest, "reason", environment.BUILDCHAIN_DEV_DELIVERY_REASON),
    readMode: flag(rest, "read-mode", environment.BUILDCHAIN_V4_WARRANT_READ_MODE || "v3"),
    readQualificationPath: flag(rest, "read-qualification", environment.BUILDCHAIN_V4_WARRANT_READ_QUALIFICATION),
    readQualificationRoot: flag(rest, "read-qualification-root", environment.BUILDCHAIN_V4_WARRANT_READ_QUALIFICATION_ROOT),
    readTypescriptRevision: flag(rest, "read-typescript-revision", environment.BUILDCHAIN_V4_WARRANT_TYPESCRIPT_REVISION),
    readRustRevision: flag(rest, "read-rust-revision", environment.BUILDCHAIN_V4_WARRANT_RUST_REVISION),
    readValidatorVersion: flag(rest, "read-validator-version", environment.BUILDCHAIN_V4_WARRANT_VALIDATOR_VERSION),
    readTimeoutMs: flag(rest, "read-timeout-ms", environment.BUILDCHAIN_V4_WARRANT_READ_TIMEOUT_MS || "5000"),
    readEvidenceOutput: flag(rest, "read-evidence-output", environment.BUILDCHAIN_V4_WARRANT_READ_EVIDENCE || ".buildchain/dev-delivery/v4-read-evidence.json"),
    now: flag(rest, "now", environment.BUILDCHAIN_DEV_DELIVERY_NOW),
    outputPath: flag(rest, "output", environment.BUILDCHAIN_DEV_DELIVERY_OUTPUT || ".buildchain/dev-delivery/result.json"),
    execute: hasFlag(rest, "execute"),
    json: hasFlag(rest, "json"),
  };
}

function usage() {
  return "Usage:\n  buildchain dev warrant <submit|select|heartbeat|recover|close|settle|cancel-queued|observe> --repository owner/repo --branch dev/vN/vN.M [--execute] [--output FILE] [--json]\n\nRead candidate:\n  observe --read-mode v4 --read-qualification FILE --read-qualification-root sha256:... --read-typescript-revision SHA --read-rust-revision SHA --read-validator-version TOKEN [--read-evidence-output FILE]\n";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || hasFlag(args, "help")) {
    process.stdout.write(usage());
    return;
  }
  const options = devDeliveryCliOptions(args);
  if (!["submit", "select", "heartbeat", "recover", "close", "settle", "cancel-queued", "observe"].includes(options.command)) {
    throw new Error(usage().trim());
  }
  const result = await runDevDeliveryCommand(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Buildchain dev delivery ${options.command}: ${result.receipt?.reason || result.mode}\n`);
    process.stdout.write(`State root: ${result.after?.stateRoot || result.observation.stateRoot}\n`);
    if (result.receiptRoot) process.stdout.write(`Receipt root: ${result.receiptRoot}\n`);
    process.stdout.write(`Result: ${options.outputPath}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`buildchain dev warrant: ${error.message}`);
    process.exit(1);
  });
}
