import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  discoverVerification,
  planVerification,
  readProofArchive,
  sealVerification,
} from "../scripts/source-verification-evidence.mjs";

const r = `sha256:${"1".repeat(64)}`;
const identity = {
  repository: "owner/repo",
  sourceSha: "a".repeat(40),
  sourceTree: "b".repeat(40),
  workflowRoot: r,
  checkDefinitionRoot: r,
  runtimeRoot: r,
  toolchainRoot: r,
  dependencyRoot: r,
  environmentRoot: r,
  platform: "linux-x64",
};
const evidence = () => ({
  schema: "buildchain-v4-source-verification-evidence/v1",
  identity,
  runId: "123",
  runAttempt: 1,
  event: "merge_group",
  validationKind: "full-source",
  startedAtMs: 1000,
  completedAtMs: 2000,
  expiresAtMs: 5000,
  exitCode: 0,
});
const provider = {
  repository: "owner/repo",
  runId: "123",
  runAttempt: 1,
  headSha: identity.sourceSha,
  event: "merge_group",
  status: "completed",
  conclusion: "success",
  workflowPath: ".github/workflows/verify.yml",
  artifactDigest: r,
};
const request = () => ({
  expected: identity,
  evaluatedAtMs: 3000,
  candidate: sealVerification(evidence()),
  provider,
});

test("Rust/WASM source verification reuses only an exact successful full execution", () => {
  assert.equal(planVerification(request()).decision, "reuse");
  for (const key of Object.keys(identity)) {
    const changed = request();
    changed.expected = {
      ...identity,
      [key]:
        key === "repository"
          ? "other/repo"
          : key === "platform"
            ? "windows-x64"
            : key === "sourceSha" || key === "sourceTree"
              ? "c".repeat(40)
              : `sha256:${"2".repeat(64)}`,
    };
    assert.equal(planVerification(changed).decision, "execute", key);
  }
});

test("missing, tampered, expired, future, failed and projected proofs never reuse", () => {
  for (const override of [
    { candidate: null },
    { provider: null },
    { evaluatedAtMs: 5000 },
    { evaluatedAtMs: 1999 },
  ])
    assert.equal(
      planVerification({ ...request(), ...override }).decision,
      "execute",
    );
  const tampered = request();
  tampered.candidate.evidenceRoot = `sha256:${"f".repeat(64)}`;
  assert.equal(planVerification(tampered).reason, "root-mismatch");
  for (const override of [
    { exitCode: 1 },
    { validationKind: "version-state-projection" },
    { event: "pull_request" },
    { expiresAtMs: 21602001 },
    { unexpected: true },
  ])
    assert.throws(() => sealVerification({ ...evidence(), ...override }));
  for (const override of [
    { runAttempt: 2 },
    { conclusion: "failure" },
    { repository: "fork/repo" },
    { event: "pull_request" },
    { workflowPath: ".github/workflows/other.yml" },
  ])
    assert.equal(
      planVerification({ ...request(), provider: { ...provider, ...override } })
        .decision,
      "execute",
    );
});

function archive(candidate) {
  return execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c",
      "import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z: z.writestr('evidence.json',sys.stdin.read())\nsys.stdout.buffer.write(b.getvalue())",
    ],
    { input: JSON.stringify(candidate) },
  );
}

test("artifact transport checks exact archive bytes before parsing proof JSON", () => {
  const candidate = request().candidate;
  const bytes = archive(candidate);
  const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  assert.deepEqual(readProofArchive(bytes, digest), candidate);
  const corrupt = Buffer.from(bytes);
  corrupt[0] ^= 1;
  assert.throws(() => readProofArchive(corrupt, digest), /digest mismatch/u);
});

test("discovery binds the provider run and artifact and falls back on transport failure", async () => {
  const bytes = archive(request().candidate);
  const run = {
    id: 123,
    run_attempt: 1,
    repository: { full_name: identity.repository },
    head_sha: identity.sourceSha,
    path: provider.workflowPath,
    event: "merge_group",
    status: "completed",
    conclusion: "success",
  };
  const asset = {
    id: 456,
    name: `source-verification-${identity.sourceSha}-1`,
    expired: false,
    size_in_bytes: bytes.length,
    digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
  };
  const input = {
    expected: identity,
    evaluatedAtMs: 3000,
    fetchJson: async (endpoint) =>
      endpoint.includes("/workflows/")
        ? { workflow_runs: [run] }
        : endpoint.includes("/artifacts?")
          ? { artifacts: [asset] }
          : run,
    fetchArchive: async () => bytes,
  };
  assert.equal((await discoverVerification(input)).decision, "reuse");
  assert.equal(
    (
      await discoverVerification({
        ...input,
        fetchArchive: async () => {
          throw new Error("reset");
        },
      })
    ).decision,
    "execute",
  );
  run.path = ".github/workflows/untrusted.yml";
  assert.equal((await discoverVerification(input)).decision, "execute");
});

test("Rust/WASM version projection admits only the immediate v4 alpha successor", async () => {
  const { invokeV4DomainWasm } =
    await import("../packages/core/v4-domain-wasm.js");
  const project = (version, baseVersion = "4.0.2-alpha.34") =>
    invokeV4DomainWasm("source-version-projection", { baseVersion, version });
  assert.equal(project("4.0.2-alpha.35").valid, true);
  for (const version of [
    "4.0.2-alpha.34",
    "4.0.2-alpha.33",
    "4.0.2-alpha.36",
    "4.0.2",
    "4.1.0-alpha.35",
    "5.0.2-alpha.35",
  ])
    assert.throws(() => project(version));
  assert.throws(() =>
    project("4.0.2-alpha.1", "4.0.2-alpha.18446744073709551615"),
  );
  assert.throws(() => project("3.0.2-alpha.35", "3.0.2-alpha.34"));
});
