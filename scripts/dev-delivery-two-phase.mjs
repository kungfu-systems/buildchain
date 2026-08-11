#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  createNativeProofReuseDecision,
  createNativeQualificationProof,
  devDeliveryContentRoot,
} from "../packages/core/dev-delivery-warrant.js";
import { runNativeWithHeartbeat } from "./dev-delivery-native-run.mjs";
import { runDevDeliveryCommand } from "./dev-delivery-warrant.mjs";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function positiveInteger(value, label, fallback = 0) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
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

function exactSha(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(`${label} must be an exact lowercase Git SHA`);
  }
  return normalized;
}

function readJson(file, label) {
  if (!file) throw new Error(`${label} is required`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export class GitHubTwoPhaseClient {
  constructor({
    repository,
    token,
    apiUrl = "https://api.github.com",
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!token) throw new Error("GITHUB_TOKEN is required");
    this.repository = repository;
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/u, "");
    this.fetch = fetchImpl;
  }

  async request(requestPath, { method = "GET", body } = {}) {
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
    if (!response.ok) throw new Error(data?.message || `${requestPath} failed`);
    return data;
  }

  async baseSha(branch) {
    const data = await this.request(
      `/repos/${this.repository}/git/ref/heads/${branch
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
    return exactSha(data?.object?.sha, "protected base SHA");
  }

  async exactPullRequestHead(pullRequestNumber, expectedHead) {
    const data = await this.request(
      `/repos/${this.repository}/pulls/${pullRequestNumber}`,
    );
    const observed = exactSha(data?.head?.sha, "observed PR head");
    if (observed !== expectedHead) {
      throw new Error(
        `semantic source head changed: ${observed} != ${expectedHead}`,
      );
    }
    return observed;
  }

  async baseDelta(previousBase, currentBase) {
    if (previousBase === currentBase) {
      return { graphKnown: true, changedPaths: [] };
    }
    const data = await this.request(
      `/repos/${this.repository}/compare/${previousBase}...${currentBase}`,
    );
    const files = Array.isArray(data.files) ? data.files : [];
    const graphKnown =
      data.status === "ahead" &&
      data.merge_base_commit?.sha === previousBase &&
      files.length < 300;
    return {
      graphKnown,
      changedPaths: graphKnown
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
    };
  }

  async wake(eventType, candidate) {
    await this.request(`/repos/${this.repository}/dispatches`, {
      method: "POST",
      body: {
        event_type: eventType,
        client_payload: candidate,
      },
    });
  }
}

function semanticCurrent(options, currentBase, delta) {
  return {
    sourceIdentityRoot: options.sourceIdentityRoot,
    sourcePatchRoot: options.sourcePatchRoot,
    planRoot: options.planRoot,
    closureRoot: options.closureRoot,
    dependencyRoot: options.dependencyRoot,
    toolchainRoot: options.toolchainRoot,
    currentBase,
    graphKnown: delta.graphKnown,
    changedPaths: delta.changedPaths,
  };
}

function composeCandidate(candidateDirectory, expectedHead, baseSha) {
  try {
    execFileSync("git", ["-C", candidateDirectory, "merge", "--abort"], {
      stdio: "ignore",
    });
  } catch {
    // No merge was active.
  }
  execFileSync(
    "git",
    ["-C", candidateDirectory, "reset", "--hard", expectedHead],
    {
      stdio: "ignore",
    },
  );
  execFileSync(
    "git",
    ["-C", candidateDirectory, "merge", "--no-commit", "--no-ff", baseSha],
    { stdio: "pipe" },
  );
}

async function classifyAgainstCurrent(proof, options, client) {
  const currentBase = await client.baseSha(options.branch);
  const delta = await client.baseDelta(proof.qualifiedBase, currentBase);
  const current = semanticCurrent(options, currentBase, delta);
  return {
    current,
    decision: createNativeProofReuseDecision({ proof, current }),
  };
}

async function releaseFailedAttempt({
  error,
  options,
  warrant,
  nativeAttempts,
  evidenceDirectory,
  runCommand,
  client,
}) {
  const failure = {
    schema: "kungfu.buildchain.two-phase-delivery-failure/v1",
    pullRequestNumber: options.pullRequestNumber,
    expectedHead: options.expectedHead,
    fencingToken: warrant.fencingToken,
    leaseGeneration: warrant.generation,
    nativeAttempts,
    reason: error.message,
  };
  const evidenceRoot = devDeliveryContentRoot(failure);
  writeJson(path.join(evidenceDirectory, "failure.json"), {
    ...failure,
    evidenceRoot,
  });
  try {
    const closed = await runCommand({
      command: "close",
      repository: options.repository,
      branch: options.branch,
      fencingToken: warrant.fencingToken,
      leaseGeneration: warrant.generation,
      outcome: "terminal-failure",
      evidenceRoot,
      reason: error.message,
      execute: true,
      token: options.token,
      apiUrl: options.apiUrl,
    });
    writeJson(path.join(evidenceDirectory, "failure-close.json"), closed);
    const nextCandidate = closed.observation?.queued?.[0] || null;
    if (nextCandidate && options.wakeEventType) {
      try {
        await client.wake(options.wakeEventType, {
          schema: "kungfu.buildchain.dev-delivery-wake/v1",
          targetBranch: options.branch,
          ...nextCandidate,
        });
        writeJson(path.join(evidenceDirectory, "wake-next.json"), {
          schema: "kungfu.buildchain.dev-delivery-wake-receipt/v1",
          eventType: options.wakeEventType,
          candidateId: nextCandidate.candidateId,
          pullRequestNumber: nextCandidate.pullRequestNumber,
          sourceHead: nextCandidate.sourceHead,
          action: "repository-dispatch-sent",
        });
      } catch (wakeError) {
        writeJson(path.join(evidenceDirectory, "wake-next-error.json"), {
          schema: "kungfu.buildchain.dev-delivery-wake-error/v1",
          reason: wakeError.message,
          candidateId: nextCandidate.candidateId,
          nextAction:
            "A later candidate submission or lease recovery will retry deterministic selection.",
        });
      }
    }
  } catch (closeError) {
    writeJson(path.join(evidenceDirectory, "failure-close-error.json"), {
      schema: "kungfu.buildchain.two-phase-delivery-close-error/v1",
      reason: closeError.message,
      nextAction:
        "Recover the expired lease or close the current fenced generation; no merge admission was attempted.",
    });
  }
}

export async function runTwoPhaseDelivery(options, dependencies = {}) {
  const client =
    dependencies.client ||
    new GitHubTwoPhaseClient({
      repository: options.repository,
      token: options.token,
      apiUrl: options.apiUrl,
    });
  const runCommand = dependencies.runCommand || runDevDeliveryCommand;
  const runNative = dependencies.runNative || runNativeWithHeartbeat;
  const warrantResult = readJson(options.warrantResultPath, "Warrant result");
  const warrant =
    warrantResult.observation?.activeWarrant || warrantResult.warrant;
  if (!warrant || warrant.phase !== "provisional") {
    throw new Error(
      "two-phase delivery requires an active provisional Warrant",
    );
  }
  if (
    Number(warrant.pullRequestNumber) !== options.pullRequestNumber ||
    warrant.sourceHead !== options.expectedHead
  ) {
    throw new Error("provisional Warrant does not match the exact PR head");
  }
  const evidenceDirectory = path.resolve(options.evidenceDirectory);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  let proof = options.nativeProofPath
    ? readJson(options.nativeProofPath, "native proof")
    : null;
  let classified = proof
    ? await classifyAgainstCurrent(proof, options, client)
    : null;
  let nativeAttempts = 0;

  try {
    while (true) {
      if (classified?.decision.reusable) {
        await client.exactPullRequestHead(
          options.pullRequestNumber,
          options.expectedHead,
        );
        classified = await classifyAgainstCurrent(proof, options, client);
        if (classified.decision.reusable) break;
      }
      if (nativeAttempts >= 2) break;
      if (!String(options.nativeCommand || "").trim()) {
        throw new Error(
          `native proof cannot be reused (${classified?.decision.reason || "not-supplied"}) and native-command is empty`,
        );
      }
      await client.exactPullRequestHead(
        options.pullRequestNumber,
        options.expectedHead,
      );
      const qualifiedBase = await client.baseSha(options.branch);
      composeCandidate(
        options.candidateDirectory,
        options.expectedHead,
        qualifiedBase,
      );
      nativeAttempts += 1;
      const heartbeatReceipt = await runNative({
        command: options.nativeCommand,
        cwd: options.candidateDirectory,
        intervalMs: options.heartbeatSeconds * 1000,
        executionBinding: {
          repository: options.repository,
          protectedBase: options.branch,
          sourceHead: options.expectedHead,
          qualifiedBase,
          toolchainRoot: options.toolchainRoot,
        },
        heartbeat: async () => {
          await runCommand({
            command: "heartbeat",
            repository: options.repository,
            branch: options.branch,
            fencingToken: warrant.fencingToken,
            leaseGeneration: warrant.generation,
            leaseSeconds: options.leaseSeconds,
            execute: true,
            token: options.token,
            apiUrl: options.apiUrl,
          });
        },
      });
      writeJson(
        path.join(
          evidenceDirectory,
          `native-heartbeat-attempt-${nativeAttempts}.json`,
        ),
        heartbeatReceipt,
      );
      await client.exactPullRequestHead(
        options.pullRequestNumber,
        options.expectedHead,
      );
      proof = createNativeQualificationProof({
        repository: options.repository,
        protectedBase: options.branch,
        sourceIdentityRoot: options.sourceIdentityRoot,
        sourcePatchRoot: options.sourcePatchRoot,
        planRoot: options.planRoot,
        closureRoot: options.closureRoot,
        dependencyRoot: options.dependencyRoot,
        toolchainRoot: options.toolchainRoot,
        qualifiedBase,
        affectedPaths: options.affectedPaths,
        shardEvidenceRoots: [
          ...options.shardEvidenceRoots,
          heartbeatReceipt.receiptRoot,
        ],
        qualifiedAt: new Date().toISOString(),
      });
      classified = await classifyAgainstCurrent(proof, options, client);
    }

    if (!classified?.decision.reusable) {
      throw new Error(
        `native proof remains non-reusable after ${nativeAttempts} attempt(s): ${classified?.decision.reason || "unknown"}`,
      );
    }
    writeJson(path.join(evidenceDirectory, "native-proof.json"), proof);
    writeJson(
      path.join(evidenceDirectory, "native-reuse-decision.json"),
      classified.decision,
    );
    const qualified = await runCommand({
      command: "qualify",
      repository: options.repository,
      branch: options.branch,
      fencingToken: warrant.fencingToken,
      leaseGeneration: warrant.generation,
      nativeProofPath: path.join(evidenceDirectory, "native-proof.json"),
      nativeReuseDecisionPath: path.join(
        evidenceDirectory,
        "native-reuse-decision.json",
      ),
      currentBase: classified.current.currentBase,
      graphKnown: classified.current.graphKnown,
      changedPaths: JSON.stringify(classified.current.changedPaths),
      execute: true,
      token: options.token,
      apiUrl: options.apiUrl,
    });
    writeJson(
      path.join(evidenceDirectory, "qualified-warrant.json"),
      qualified,
    );
    return {
      schema: "kungfu.buildchain.two-phase-delivery-result/v1",
      ok: true,
      outcome: "qualified-warrant",
      nativeAttempts,
      nativeProofRoot: proof.proofRoot,
      nativeReuseDecisionRoot: classified.decision.decisionRoot,
      qualificationReceiptRoot: qualified.receiptRoot,
      qualifiedWarrant: qualified.observation.activeWarrant,
    };
  } catch (error) {
    await releaseFailedAttempt({
      error,
      options,
      warrant,
      nativeAttempts,
      evidenceDirectory,
      runCommand,
      client,
    });
    throw error;
  }
}

function cliOptions(args, environment = process.env) {
  const leaseSeconds = positiveInteger(
    flag(
      args,
      "lease-seconds",
      environment.BUILDCHAIN_DEV_DELIVERY_LEASE_SECONDS,
    ),
    "leaseSeconds",
    3600,
  );
  const heartbeatSeconds = positiveInteger(
    flag(
      args,
      "heartbeat-seconds",
      environment.BUILDCHAIN_DEV_DELIVERY_HEARTBEAT_SECONDS,
    ),
    "heartbeatSeconds",
    Math.max(15, Math.floor(leaseSeconds / 3)),
  );
  if (heartbeatSeconds >= leaseSeconds) {
    throw new Error("heartbeatSeconds must be less than leaseSeconds");
  }
  return {
    repository: flag(args, "repository", environment.GITHUB_REPOSITORY),
    branch: flag(
      args,
      "branch",
      environment.BUILDCHAIN_DEV_DELIVERY_BRANCH || environment.GITHUB_BASE_REF,
    ),
    pullRequestNumber: positiveInteger(
      flag(args, "pull-request", environment.BUILDCHAIN_DEV_DELIVERY_PR_NUMBER),
      "pullRequestNumber",
    ),
    expectedHead: exactSha(
      flag(
        args,
        "expected-head",
        environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_HEAD,
      ),
      "expectedHead",
    ),
    sourceIdentityRoot: flag(
      args,
      "source-identity-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_IDENTITY_ROOT,
    ),
    sourcePatchRoot: flag(
      args,
      "source-patch-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PATCH_ROOT,
    ),
    planRoot: flag(
      args,
      "plan-root",
      environment.BUILDCHAIN_DEV_DELIVERY_PLAN_ROOT,
    ),
    closureRoot: flag(
      args,
      "closure-root",
      environment.BUILDCHAIN_DEV_DELIVERY_CLOSURE_ROOT,
    ),
    dependencyRoot: flag(
      args,
      "dependency-root",
      environment.BUILDCHAIN_DEV_DELIVERY_DEPENDENCY_ROOT,
    ),
    toolchainRoot: flag(
      args,
      "toolchain-root",
      environment.BUILDCHAIN_DEV_DELIVERY_TOOLCHAIN_ROOT,
    ),
    affectedPaths: jsonList(
      flag(
        args,
        "affected-paths-json",
        environment.BUILDCHAIN_DEV_DELIVERY_AFFECTED_PATHS,
      ),
      "affectedPaths",
    ),
    shardEvidenceRoots: jsonList(
      flag(
        args,
        "shard-evidence-roots-json",
        environment.BUILDCHAIN_DEV_DELIVERY_SHARD_EVIDENCE_ROOTS,
      ),
      "shardEvidenceRoots",
    ),
    nativeCommand: flag(
      args,
      "native-command",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_COMMAND,
    ),
    nativeProofPath: flag(
      args,
      "native-proof",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_PROOF,
    ),
    warrantResultPath: flag(
      args,
      "warrant-result",
      environment.BUILDCHAIN_DEV_DELIVERY_WARRANT_RESULT,
    ),
    candidateDirectory: path.resolve(
      flag(args, "candidate-directory", ".buildchain/candidate"),
    ),
    evidenceDirectory: path.resolve(
      flag(args, "evidence-directory", ".buildchain/dev-delivery"),
    ),
    leaseSeconds,
    heartbeatSeconds,
    token: environment.GITHUB_TOKEN,
    apiUrl: environment.GITHUB_API_URL || "https://api.github.com",
    wakeEventType: flag(
      args,
      "wake-event-type",
      environment.BUILDCHAIN_DEV_DELIVERY_WAKE_EVENT_TYPE ||
        "buildchain-dev-delivery-wake",
    ),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    process.stdout.write(
      "Usage: buildchain dev two-phase --repository owner/repo --branch dev/vN/vN.M --pull-request N --expected-head SHA --warrant-result FILE [--native-proof FILE] [--native-command COMMAND]\n",
    );
    return;
  }
  const options = cliOptions(args);
  const result = await runTwoPhaseDelivery(options);
  writeJson(
    path.join(options.evidenceDirectory, "two-phase-result.json"),
    result,
  );
  process.stdout.write(
    `Two-phase Delivery Warrant: ${result.qualificationReceiptRoot}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`buildchain dev two-phase: ${error.message}`);
    process.exit(1);
  });
}
