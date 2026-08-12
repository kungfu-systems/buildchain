import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createNativeQualificationProof } from "../packages/core/dev-delivery-warrant.js";
import {
  composeCandidate,
  GitHubTwoPhaseClient,
  runTwoPhaseDelivery,
} from "../scripts/dev-delivery-two-phase.mjs";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

test("candidate replay composes a divergent base without ambient Git identity", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-two-phase-compose-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  assert.equal(git("init").status, 0);
  fs.writeFileSync(path.join(directory, "source.txt"), "base\n");
  assert.equal(git("add", "source.txt").status, 0);
  assert.equal(
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "base",
    ).status,
    0,
  );
  const base = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(git("switch", "-c", "candidate").status, 0);
  fs.writeFileSync(path.join(directory, "candidate.txt"), "candidate\n");
  assert.equal(git("add", "candidate.txt").status, 0);
  assert.equal(
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "candidate",
    ).status,
    0,
  );
  const head = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(git("switch", "--detach", base).status, 0);
  fs.writeFileSync(path.join(directory, "base.txt"), "advanced base\n");
  assert.equal(git("add", "base.txt").status, 0);
  assert.equal(
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "advance base",
    ).status,
    0,
  );
  const advancedBase = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(git("config", "user.name", "").status, 0);
  assert.equal(git("config", "user.email", "").status, 0);

  assert.doesNotThrow(() => composeCandidate(directory, head, advancedBase));
  assert.equal(git("rev-parse", "HEAD").stdout.trim(), head);
  assert.equal(
    fs.readFileSync(path.join(directory, "base.txt"), "utf8"),
    "advanced base\n",
  );
});

test("GitHub base delta attributes both sides of a rename", async () => {
  const client = new GitHubTwoPhaseClient({
    repository: "kungfu-systems/buildchain",
    token: "fixture",
    apiUrl: "https://example.invalid",
    fetchImpl: async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          status: "ahead",
          merge_base_commit: { sha: BASE },
          files: [
            {
              filename: "docs/native.md",
              previous_filename: "packages/native/README.md",
            },
          ],
        }),
    }),
  });
  assert.deepEqual(await client.baseDelta(BASE, "c".repeat(40)), {
    graphKnown: true,
    changedPaths: ["docs/native.md", "packages/native/README.md"],
  });
});

test("GitHub wake preserves the complete candidate under one dispatch property", async () => {
  const requests = [];
  const client = new GitHubTwoPhaseClient({
    repository: "kungfu-systems/buildchain",
    token: "fixture",
    apiUrl: "https://example.invalid",
    fetchImpl: async (url, requestOptions) => {
      requests.push({ url, requestOptions });
      return { ok: true, text: async () => "" };
    },
  });
  const candidate = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`binding${index}`, ROOT("a")]),
  );

  await client.wake("buildchain-dev-delivery-wake", candidate);

  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].requestOptions.body);
  assert.equal(body.event_type, "buildchain-dev-delivery-wake");
  assert.deepEqual(Object.keys(body.client_payload), ["candidate"]);
  assert.deepEqual(body.client_payload.candidate, candidate);
});

function options(directory, proofPath) {
  return {
    repository: "kungfu-systems/buildchain",
    branch: "dev/v3/v3.0",
    pullRequestNumber: 501,
    expectedHead: HEAD,
    sourceIdentityRoot: ROOT("1"),
    sourcePatchRoot: ROOT("2"),
    planRoot: ROOT("3"),
    closureRoot: ROOT("4"),
    dependencyRoot: ROOT("5"),
    toolchainRoot: ROOT("6"),
    affectedPaths: ["packages/native"],
    shardEvidenceRoots: [],
    nativeCommand: "",
    nativeProofPath: proofPath,
    warrantResultPath: path.join(directory, "warrant.json"),
    candidateDirectory: directory,
    evidenceDirectory: directory,
    leaseSeconds: 120,
    heartbeatSeconds: 30,
    token: "fixture",
    apiUrl: "https://example.invalid",
    wakeEventType: "buildchain-dev-delivery-wake",
  };
}

test("two-phase controller reuses disjoint native proof and qualifies before merge admission", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-two-phase-run-"),
  );
  const proof = createNativeQualificationProof({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    sourceIdentityRoot: ROOT("1"),
    sourcePatchRoot: ROOT("2"),
    planRoot: ROOT("3"),
    closureRoot: ROOT("4"),
    dependencyRoot: ROOT("5"),
    toolchainRoot: ROOT("6"),
    qualifiedBase: BASE,
    affectedPaths: ["packages/native"],
    shardEvidenceRoots: [ROOT("7")],
    qualifiedAt: "2026-08-11T00:00:00Z",
  });
  const proofPath = path.join(directory, "proof.json");
  fs.writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);
  const warrant = {
    schema: "kungfu.buildchain.dev-delivery-warrant/v1",
    phase: "provisional",
    pullRequestNumber: 501,
    sourceHead: HEAD,
    candidateId: ROOT("8"),
    fencingToken: ROOT("9"),
    generation: 1,
  };
  fs.writeFileSync(
    path.join(directory, "warrant.json"),
    `${JSON.stringify({ observation: { activeWarrant: warrant } })}\n`,
  );
  const calls = [];
  try {
    const result = await runTwoPhaseDelivery(options(directory, proofPath), {
      client: {
        baseSha: async () => "c".repeat(40),
        exactPullRequestHead: async () => HEAD,
        baseDelta: async () => ({
          graphKnown: true,
          changedPaths: ["docs/guide.md"],
        }),
      },
      runCommand: async (input) => {
        calls.push(input);
        return {
          receiptRoot: ROOT("a"),
          observation: {
            activeWarrant: { ...warrant, phase: "qualified" },
          },
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.nativeAttempts, 0);
    assert.equal(result.nativeProofRoot, proof.proofRoot);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "qualify");
    assert.equal(calls[0].graphKnown, true);
    assert.deepEqual(JSON.parse(calls[0].changedPaths), ["docs/guide.md"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("two-phase proof reuse rejects a changed exact PR head and releases the lease", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-two-phase-head-drift-"),
  );
  const proof = createNativeQualificationProof({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    sourceIdentityRoot: ROOT("1"),
    sourcePatchRoot: ROOT("2"),
    planRoot: ROOT("3"),
    closureRoot: ROOT("4"),
    dependencyRoot: ROOT("5"),
    toolchainRoot: ROOT("6"),
    qualifiedBase: BASE,
    affectedPaths: ["packages/native"],
    shardEvidenceRoots: [ROOT("7")],
    qualifiedAt: "2026-08-11T00:00:00Z",
  });
  const proofPath = path.join(directory, "proof.json");
  fs.writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);
  const warrant = {
    phase: "provisional",
    pullRequestNumber: 501,
    sourceHead: HEAD,
    candidateId: ROOT("8"),
    fencingToken: ROOT("9"),
    generation: 1,
  };
  fs.writeFileSync(
    path.join(directory, "warrant.json"),
    `${JSON.stringify({ observation: { activeWarrant: warrant } })}\n`,
  );
  const calls = [];
  try {
    await assert.rejects(
      runTwoPhaseDelivery(options(directory, proofPath), {
        client: {
          baseSha: async () => BASE,
          baseDelta: async () => ({ graphKnown: true, changedPaths: [] }),
          exactPullRequestHead: async () => {
            throw new Error("semantic source head changed");
          },
        },
        runCommand: async (input) => {
          calls.push(input);
          return { receiptRoot: ROOT("a"), observation: { queued: [] } };
        },
      }),
      /semantic source head changed/u,
    );
    assert.deepEqual(
      calls.map((entry) => entry.command),
      ["close"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal native failure closes the fenced lease and wakes the next candidate", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-two-phase-wake-"),
  );
  const configured = options(directory, "");
  const warrant = {
    schema: "kungfu.buildchain.dev-delivery-warrant/v1",
    phase: "provisional",
    pullRequestNumber: 501,
    sourceHead: HEAD,
    candidateId: ROOT("8"),
    fencingToken: ROOT("9"),
    generation: 1,
  };
  fs.writeFileSync(
    configured.warrantResultPath,
    `${JSON.stringify({ observation: { activeWarrant: warrant } })}\n`,
  );
  const wakeCalls = [];
  const commandCalls = [];
  try {
    await assert.rejects(
      runTwoPhaseDelivery(configured, {
        client: {
          wake: async (...args) => wakeCalls.push(args),
        },
        runCommand: async (input) => {
          commandCalls.push(input);
          return {
            receiptRoot: ROOT("a"),
            observation: {
              queued: [
                {
                  position: 1,
                  candidateId: ROOT("b"),
                  pullRequestNumber: 502,
                  sourceHead: "d".repeat(40),
                  assignmentRoot: ROOT("1"),
                  initiativeRoot: ROOT("2"),
                  sourceIdentityRoot: ROOT("3"),
                  sourcePatchRoot: ROOT("4"),
                  sourceProofRoot: ROOT("5"),
                  planRoot: ROOT("6"),
                  closureRoot: ROOT("7"),
                  dependencyRoot: ROOT("8"),
                  toolchainRoot: ROOT("9"),
                  affectedPaths: ["packages/native"],
                  deliveryClass: "native-proof-required",
                  priority: "ordinary",
                },
              ],
            },
          };
        },
      }),
      /native proof cannot be reused/u,
    );
    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0].command, "close");
    assert.equal(commandCalls[0].outcome, "terminal-failure");
    assert.equal(wakeCalls.length, 1);
    assert.equal(wakeCalls[0][0], "buildchain-dev-delivery-wake");
    assert.equal(wakeCalls[0][1].pullRequestNumber, 502);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(directory, "wake-next.json"), "utf8"),
      ).action,
      "repository-dispatch-sent",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
