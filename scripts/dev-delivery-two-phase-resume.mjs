import { execFileSync } from "node:child_process";

import {
  createNativeCommandContract,
  createNativeProofReuseDecision,
  createNativeQualificationProof,
} from "../packages/core/dev-delivery-warrant.js";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function exactLocalSha(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized))
    throw new Error(`${label} must be an exact lowercase Git SHA`);
  return normalized;
}

export class LocalTwoPhaseClient {
  constructor({ candidateDirectory } = {}) {
    this.candidateDirectory = candidateDirectory;
  }

  git(args, options = {}) {
    return execFileSync("git", ["-C", this.candidateDirectory, ...args], {
      encoding: "utf8",
      ...options,
    }).trim();
  }

  async baseSha(branch) {
    return exactLocalSha(
      this.git(["rev-parse", `refs/remotes/origin/${branch}`]),
      "protected base SHA",
    );
  }

  async exactPullRequestHead(_pullRequestNumber, expectedHead) {
    const observed = exactLocalSha(this.git(["rev-parse", "HEAD"]), "PR head");
    if (observed !== expectedHead)
      throw new Error(
        `semantic source head changed: ${observed} != ${expectedHead}`,
      );
    return observed;
  }

  async baseDelta(previousBase, currentBase) {
    if (previousBase === currentBase)
      return {
        graphKnown: true,
        attributionComplete: true,
        changedPaths: [],
        renames: [],
      };
    try {
      this.git(["merge-base", "--is-ancestor", previousBase, currentBase]);
    } catch {
      return {
        graphKnown: false,
        attributionComplete: false,
        changedPaths: [],
        renames: [],
      };
    }
    const entries = this.git([
      "diff",
      "--name-status",
      "-M",
      previousBase,
      currentBase,
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const renames = entries
      .filter(([status]) => status.startsWith("R"))
      .map(([, from, to]) => ({ from, to }));
    return {
      graphKnown: true,
      attributionComplete: renames.every(({ from, to }) => from && to),
      changedPaths: [
        ...new Set(entries.flatMap(([, ...paths]) => paths).filter(Boolean)),
      ].sort(),
      renames,
    };
  }
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
    return exactLocalSha(data?.object?.sha, "protected base SHA");
  }

  async exactPullRequestHead(pullRequestNumber, expectedHead) {
    const data = await this.request(
      `/repos/${this.repository}/pulls/${pullRequestNumber}`,
    );
    const observed = exactLocalSha(data?.head?.sha, "observed PR head");
    if (observed !== expectedHead)
      throw new Error(
        `semantic source head changed: ${observed} != ${expectedHead}`,
      );
    return observed;
  }

  async baseDelta(previousBase, currentBase) {
    if (previousBase === currentBase)
      return {
        graphKnown: true,
        attributionComplete: true,
        changedPaths: [],
        renames: [],
      };
    const data = await this.request(
      `/repos/${this.repository}/compare/${previousBase}...${currentBase}`,
    );
    return attributedGitHubBaseDelta(data, previousBase);
  }

  async wake(eventType, candidate) {
    await this.request(`/repos/${this.repository}/dispatches`, {
      method: "POST",
      body: { event_type: eventType, client_payload: { candidate } },
    });
  }
}

export function attributedGitHubBaseDelta(data, previousBase) {
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
    graphKnown && renames.every((entry) => entry.from && entry.to);
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

export async function replayQualifiedNativeWarrant({
  warrant,
  pullRequestNumber,
  expectedHead,
  exactPullRequestHead,
}) {
  if (warrant.phase !== "qualified") return null;
  if (
    !ROOT_PATTERN.test(warrant.nativeProofRoot || "") ||
    !ROOT_PATTERN.test(warrant.nativeProofReuseRoot || "") ||
    !ROOT_PATTERN.test(warrant.qualificationReceiptRoot || "")
  ) {
    throw new Error(
      "qualified Warrant replay is missing rooted native or qualification evidence",
    );
  }
  await exactPullRequestHead(pullRequestNumber, expectedHead);
  return {
    schema: "kungfu.buildchain.two-phase-delivery-result/v1",
    ok: true,
    outcome: "already-qualified-warrant",
    nativeAttempts: 0,
    nativeProofRoot: warrant.nativeProofRoot,
    nativeReuseDecisionRoot: warrant.nativeProofReuseRoot,
    qualificationReceiptRoot: warrant.qualificationReceiptRoot,
    landingAuthority: false,
    qualifiedWarrant: warrant,
  };
}

export async function classifyNativeProofAgainstCurrent(
  proof,
  options,
  client,
) {
  const currentBase = await client.baseSha(options.branch);
  const delta = await client.baseDelta(proof.qualifiedBase, currentBase);
  const current = {
    sourceHead: options.expectedHead,
    sourceIdentityRoot: options.sourceIdentityRoot,
    sourcePatchRoot: options.sourcePatchRoot,
    planRoot: options.planRoot,
    closureRoot: options.closureRoot,
    dependencyRoot: options.dependencyRoot,
    toolchainRoot: options.toolchainRoot,
    environmentRoot: options.environmentRoot,
    nativeCommandRoot: options.nativeCommandRoot,
    currentBase,
    graphKnown: delta.graphKnown,
    attributionComplete: delta.attributionComplete,
    changedPaths: delta.changedPaths,
    renames: delta.renames,
  };
  return {
    current,
    decision: createNativeProofReuseDecision({ proof, current }),
  };
}

export async function runNativeQualificationAttempt({
  options,
  warrant,
  attempt,
  client,
  runCommand,
  runNative,
  composeCandidate,
  writeEvidence,
}) {
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
  const commandContract = createNativeCommandContract(options.nativeCommand);
  if (
    commandContract.commandRoot !==
      warrant.nativeCommandContract?.commandRoot ||
    commandContract.commandRoot !== options.nativeCommandRoot
  ) {
    throw new Error(
      "native command does not match the authorized Warrant contract",
    );
  }
  const nativeExecutionReceipt = await runNative({
    command: options.nativeCommand,
    cwd: options.candidateDirectory,
    intervalMs: options.heartbeatSeconds * 1000,
    executionBinding: {
      repository: options.repository,
      protectedBase: options.branch,
      sourceHead: options.expectedHead,
      qualifiedBase,
      nativeCommandRoot: options.nativeCommandRoot,
      toolchainRoot: options.toolchainRoot,
      environmentRoot: options.environmentRoot,
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
  writeEvidence(
    `native-heartbeat-attempt-${attempt}.json`,
    nativeExecutionReceipt,
  );
  await client.exactPullRequestHead(
    options.pullRequestNumber,
    options.expectedHead,
  );
  const proof = createNativeQualificationProof({
    repository: options.repository,
    protectedBase: options.branch,
    sourceIdentityRoot: options.sourceIdentityRoot,
    sourcePatchRoot: options.sourcePatchRoot,
    planRoot: options.planRoot,
    closureRoot: options.closureRoot,
    dependencyRoot: options.dependencyRoot,
    toolchainRoot: options.toolchainRoot,
    environmentRoot: options.environmentRoot,
    sourceHead: options.expectedHead,
    qualifiedBase,
    nativeCommandRoot: options.nativeCommandRoot,
    nativeExecutionReceipt,
    affectedPaths: options.affectedPaths,
    shardEvidenceRoots: [
      ...options.shardEvidenceRoots,
      nativeExecutionReceipt.receiptRoot,
    ],
    qualifiedAt: new Date().toISOString(),
  });
  writeEvidence("native-proof.json", proof);
  return proof;
}
