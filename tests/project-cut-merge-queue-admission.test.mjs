import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  ProjectCutAdmissionError,
  parseFamilyQueueLeaseMarker,
  qualifyProjectCut,
  releaseFamilyQueueLease,
} from "../scripts/project-cut-merge-queue-admission.mjs";

const ROOT = `sha256:${"a".repeat(64)}`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(cwd, relativePath, content) {
  const target = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(cwd, message) {
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function repository() {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-project-cut-test-"),
  );
  git(cwd, "init", "-b", "base");
  git(cwd, "config", "user.name", "Buildchain Test");
  git(cwd, "config", "user.email", "buildchain-test@kungfu.tech");
  write(cwd, "shared.txt", "base\n");
  const fork = commit(cwd, "base");
  git(cwd, "switch", "-c", "source");
  write(cwd, "feature.txt", "qualified source\n");
  const head = commit(cwd, "source change");
  git(cwd, "switch", "base");
  write(cwd, "unrelated.txt", "latest protected base\n");
  const base = commit(cwd, "unrelated base advance");
  return { cwd, fork, head, base };
}

test("latest-base Project Cut retains exact source composition and family lease", (context) => {
  const fixture = repository();
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  const receipt = qualifyProjectCut({
    cwd: fixture.cwd,
    base: fixture.base,
    head: fixture.head,
    initiativeId: "initiative-one",
    assignmentId: "assignment-one",
    deliveryClass: "native-proof-required",
    queueAttempt: `${fixture.head}@${fixture.base}`,
    admissionProofRoot: ROOT,
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.compositionChanged, false);
  assert.equal(receipt.baseCommitOid, fixture.base);
  assert.equal(receipt.headCommitOid, fixture.head);
  assert.equal(receipt.forkCommitOid, fixture.fork);
  assert.equal(receipt.replayedCommitCount, 1);
  assert.match(receipt.candidateTreeOid, /^[0-9a-f]{40}$/u);
  const lease = parseFamilyQueueLeaseMarker(
    `PR body\n\n${receipt.familyLease.marker}`,
  );
  assert.equal(lease.pullRequestHead, fixture.head);
  assert.equal(lease.leaseRoot, receipt.familyLease.leaseRoot);

  const release = releaseFamilyQueueLease(receipt.familyLease.marker, {
    expectedPullRequestHead: fixture.head,
    terminalReason: "merged",
    evidenceRoot: ROOT,
  });
  assert.equal(release.state, "released");
  assert.equal(release.leaseRoot, receipt.familyLease.leaseRoot);
  assert.match(release.releaseRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("family queue attempt is bound to the exact head and latest base", (context) => {
  const fixture = repository();
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  assert.throws(
    () =>
      qualifyProjectCut({
        cwd: fixture.cwd,
        base: fixture.base,
        head: fixture.head,
        initiativeId: "initiative-one",
        assignmentId: "assignment-one",
        deliveryClass: "native-proof-required",
        queueAttempt: `${fixture.head}@${fixture.fork}`,
        admissionProofRoot: ROOT,
      }),
    (error) =>
      error instanceof ProjectCutAdmissionError &&
      error.reasonCode === "queue-attempt-drift",
  );
});

test("overlapping latest-base composition fails closed", (context) => {
  const fixture = repository();
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  git(fixture.cwd, "reset", "--hard", fixture.fork);
  write(fixture.cwd, "feature.txt", "conflicting protected base\n");
  const conflictingBase = commit(fixture.cwd, "conflicting base advance");
  assert.throws(
    () =>
      qualifyProjectCut({
        cwd: fixture.cwd,
        base: conflictingBase,
        head: fixture.head,
      }),
    (error) =>
      error instanceof ProjectCutAdmissionError &&
      error.reasonCode === "project-cut-conflict",
  );
});

test("family markers reject duplicates and release head drift", (context) => {
  const fixture = repository();
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  const receipt = qualifyProjectCut({
    cwd: fixture.cwd,
    base: fixture.base,
    head: fixture.head,
    initiativeId: "initiative-one",
    assignmentId: "assignment-one",
    deliveryClass: "native-proof-required",
    queueAttempt: `${fixture.head}@${fixture.base}`,
    admissionProofRoot: ROOT,
  });
  assert.equal(
    parseFamilyQueueLeaseMarker(
      `${receipt.familyLease.marker}\n${receipt.familyLease.marker}`,
    ),
    null,
  );
  assert.throws(
    () =>
      releaseFamilyQueueLease(receipt.familyLease.marker, {
        expectedPullRequestHead: fixture.fork,
        terminalReason: "controller-failed",
      }),
    /head drifted/u,
  );
});
