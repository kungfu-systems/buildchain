import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const GIT_OID = /^[0-9a-f]{40}$/u;
const CONTENT_ROOT = /^sha256:[0-9a-f]{64}$/u;
const FAMILY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const FAMILY_MARKER =
  /<!-- kungfu-family-queue-lease:v1 ([A-Za-z0-9_-]+) -->/gu;
const FAMILY_LEASE_SCHEMA = "kungfu.project-cut.family-queue-lease/v1";

export class ProjectCutAdmissionError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "ProjectCutAdmissionError";
    this.reasonCode = reasonCode;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(stableValue(value))}\n`, "utf8");
}

function contentRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalBytes(value)).digest("hex")}`;
}

function exactRoot(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!CONTENT_ROOT.test(normalized))
    throw new Error(`${label} must be an exact SHA-256 root`);
  return normalized;
}

function familyId(value, label) {
  const normalized = String(value || "").trim();
  if (!FAMILY_ID.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function git(
  cwd,
  args,
  {
    env = {},
    input = undefined,
    encoding = "utf8",
    reason = "git-failed",
  } = {},
) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new ProjectCutAdmissionError(
      reason,
      `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return encoding === null ? result.stdout : String(result.stdout || "").trim();
}

function resolveCommit(cwd, revision, label) {
  const oid = git(cwd, ["rev-parse", "--verify", `${revision}^{commit}`], {
    reason: `${label}-unresolved`,
  });
  if (!GIT_OID.test(oid))
    throw new ProjectCutAdmissionError(
      `${label}-unresolved`,
      `${label} is not an exact commit`,
    );
  return oid;
}

function linearSourceCommits(cwd, fork, head) {
  const commits = git(
    cwd,
    ["rev-list", "--reverse", "--topo-order", `${fork}..${head}`],
    {
      reason: "source-history-unreadable",
    },
  )
    .split(/\s+/u)
    .filter(Boolean);
  if (commits.length === 0)
    throw new ProjectCutAdmissionError(
      "empty-source-range",
      "source range is empty",
    );
  let expectedParent = fork;
  for (const commit of commits) {
    const [observed, ...parents] = git(
      cwd,
      ["rev-list", "--parents", "-n", "1", commit],
      {
        reason: "source-history-unreadable",
      },
    ).split(/\s+/u);
    if (
      observed !== commit ||
      parents.length !== 1 ||
      parents[0] !== expectedParent
    ) {
      throw new ProjectCutAdmissionError(
        "nonlinear-source-range",
        "source range is not one immutable linear patch series",
      );
    }
    expectedParent = commit;
  }
  return commits;
}

function patchId(cwd, patch) {
  const output = git(cwd, ["patch-id", "--stable"], {
    input: patch,
    encoding: "utf8",
    reason: "patch-id-failed",
  });
  const id = output.split(/\s+/u)[0] || "";
  if (!GIT_OID.test(id))
    throw new ProjectCutAdmissionError(
      "patch-id-failed",
      "patch has no stable identity",
    );
  return id;
}

function virtualCommitOid(cwd, tree, base, head) {
  const body = [
    `tree ${tree}`,
    `parent ${base}`,
    "author Buildchain Project Cut <project-cut@kungfu.tech> 0 +0000",
    "committer Buildchain Project Cut <project-cut@kungfu.tech> 0 +0000",
    "",
    `Replay ${head} onto ${base}`,
    "",
  ].join("\n");
  return git(cwd, ["hash-object", "-t", "commit", "--stdin"], {
    input: body,
    reason: "candidate-commit-hash-failed",
  });
}

function replayProjectCut(cwd, base, head) {
  const fork = git(cwd, ["merge-base", base, head], {
    reason: "no-common-fork",
  });
  if (!GIT_OID.test(fork))
    throw new ProjectCutAdmissionError(
      "no-common-fork",
      "base and head have no exact fork",
    );
  const commits = linearSourceCommits(cwd, fork, head);
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-project-cut-"),
  );
  const indexPath = path.join(temporary, "index");
  const indexEnvironment = { GIT_INDEX_FILE: indexPath };
  try {
    git(cwd, ["read-tree", base], {
      env: indexEnvironment,
      reason: "base-tree-unreadable",
    });
    const sourcePatch = git(
      cwd,
      ["diff", "--binary", "--full-index", "--no-ext-diff", fork, head],
      {
        encoding: null,
        reason: "source-patch-unreadable",
      },
    );
    git(cwd, ["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], {
      env: indexEnvironment,
      input: sourcePatch,
      encoding: "utf8",
      reason: "project-cut-conflict",
    });
    const candidateTreeOid = git(cwd, ["write-tree"], {
      env: indexEnvironment,
      reason: "candidate-tree-unreadable",
    });
    const replayPatch = git(
      cwd,
      ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", base],
      {
        env: indexEnvironment,
        encoding: null,
        reason: "replay-patch-unreadable",
      },
    );
    const sourceNames = git(
      cwd,
      ["diff", "--name-status", "--no-renames", fork, head],
      {
        reason: "source-paths-unreadable",
      },
    );
    const replayNames = git(
      cwd,
      ["diff", "--cached", "--name-status", "--no-renames", base],
      {
        env: indexEnvironment,
        reason: "replay-paths-unreadable",
      },
    );
    if (
      patchId(cwd, sourcePatch) !== patchId(cwd, replayPatch) ||
      sourceNames !== replayNames
    ) {
      throw new ProjectCutAdmissionError(
        "composition-drift",
        "latest-base replay changes the immutable source composition",
      );
    }
    return {
      baseCommitOid: base,
      headCommitOid: head,
      forkCommitOid: fork,
      candidateCommitOid: virtualCommitOid(cwd, candidateTreeOid, base, head),
      candidateTreeOid,
      replayedCommitCount: commits.length,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function encodeMarker(payload) {
  return canonicalBytes(payload)
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function decodeMarker(token) {
  const padded = `${token}${"=".repeat((4 - (token.length % 4)) % 4)}`
    .replace(/-/gu, "+")
    .replace(/_/gu, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function familyLease(input, replay) {
  const binding = {
    schema: FAMILY_LEASE_SCHEMA,
    state: "active",
    initiativeId: familyId(input.initiativeId, "initiativeId"),
    assignmentId: familyId(input.assignmentId, "assignmentId"),
    deliveryClass: familyId(input.deliveryClass, "deliveryClass"),
    admissionProofRoot: exactRoot(
      input.admissionProofRoot,
      "admissionProofRoot",
    ),
    queueAttempt: String(input.queueAttempt || "").trim(),
    pullRequestHead: replay.headCommitOid,
    baseCommitOid: replay.baseCommitOid,
    forkCommitOid: replay.forkCommitOid,
    candidateTreeOid: replay.candidateTreeOid,
  };
  const expectedAttempt = `${replay.headCommitOid}@${replay.baseCommitOid}`;
  if (binding.queueAttempt !== expectedAttempt) {
    throw new ProjectCutAdmissionError(
      "queue-attempt-drift",
      `queueAttempt must equal ${expectedAttempt}`,
    );
  }
  const bindingRoot = contentRoot(binding);
  const statusContext = `Queue family lease/${bindingRoot.slice(7, 23)}`;
  const payload = { ...binding, bindingRoot, statusContext };
  const leaseRoot = contentRoot(payload);
  const sealed = { ...payload, leaseRoot };
  return {
    marker: `<!-- kungfu-family-queue-lease:v1 ${encodeMarker(sealed)} -->`,
    leaseRoot,
    statusContext,
    pullRequestHead: replay.headCommitOid,
  };
}

export function parseFamilyQueueLeaseMarker(text) {
  const matches = [...String(text || "").matchAll(FAMILY_MARKER)];
  if (matches.length !== 1) return null;
  try {
    const payload = decodeMarker(matches[0][1]);
    const { leaseRoot, bindingRoot, statusContext, ...binding } = payload;
    if (payload.schema !== FAMILY_LEASE_SCHEMA || payload.state !== "active")
      return null;
    if (contentRoot(binding) !== bindingRoot) return null;
    if (statusContext !== `Queue family lease/${bindingRoot.slice(7, 23)}`)
      return null;
    if (contentRoot({ ...binding, bindingRoot, statusContext }) !== leaseRoot)
      return null;
    if (encodeMarker(payload) !== matches[0][1]) return null;
    exactRoot(leaseRoot, "leaseRoot");
    exactRoot(payload.admissionProofRoot, "admissionProofRoot");
    for (const field of [
      "pullRequestHead",
      "baseCommitOid",
      "forkCommitOid",
      "candidateTreeOid",
    ]) {
      if (!GIT_OID.test(String(payload[field] || ""))) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function releaseFamilyQueueLease(markerText, input = {}) {
  const lease = parseFamilyQueueLeaseMarker(markerText);
  if (!lease) throw new Error("family queue lease marker is invalid");
  const expectedHead = String(input.expectedPullRequestHead || "")
    .trim()
    .toLowerCase();
  if (!GIT_OID.test(expectedHead) || expectedHead !== lease.pullRequestHead) {
    throw new Error("family queue lease pull request head drifted");
  }
  const terminalReason = String(input.terminalReason || "").trim();
  if (!["controller-failed", "merged"].includes(terminalReason))
    throw new Error("terminalReason is invalid");
  const evidenceRoot = input.evidenceRoot
    ? exactRoot(input.evidenceRoot, "evidenceRoot")
    : null;
  if (terminalReason === "merged" && !evidenceRoot)
    throw new Error("merged family lease requires evidenceRoot");
  const receipt = {
    schema: "project.cut.family-queue-release/v1",
    state: "released",
    leaseRoot: lease.leaseRoot,
    pullRequestHead: lease.pullRequestHead,
    terminalReason,
    evidenceRoot,
  };
  return { ...receipt, releaseRoot: contentRoot(receipt) };
}

export function qualifyProjectCut(input = {}) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const base = resolveCommit(cwd, input.base, "base");
  const head = resolveCommit(cwd, input.head, "head");
  const replay = replayProjectCut(cwd, base, head);
  const familyInputs = [
    input.initiativeId,
    input.assignmentId,
    input.deliveryClass,
    input.queueAttempt,
    input.admissionProofRoot,
  ];
  const familyCount = familyInputs.filter((value) =>
    String(value || "").trim(),
  ).length;
  if (familyCount !== 0 && familyCount !== familyInputs.length) {
    throw new ProjectCutAdmissionError(
      "partial-family-binding",
      "family admission inputs must be all present or all absent",
    );
  }
  return {
    schema: "project.cut.merge-queue-admission/v1",
    ok: true,
    decision: "qualified",
    retryable: false,
    compositionChanged: false,
    reasonCodes: [],
    ...replay,
    ...(familyCount === familyInputs.length
      ? { familyLease: familyLease(input, replay) }
      : {}),
  };
}
