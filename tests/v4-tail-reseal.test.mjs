import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  V4_TAIL_RESEAL_PLATFORMS,
  normalizeV4TailResealRequest,
  planV4TailReseal,
} from "../packages/core/v4-tail-reseal.js";
import {
  createV4TailResealReceipt,
  verifyV4TailResealReceipt,
} from "../packages/core/v4-tail-reseal-receipt.js";
import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";
import { verifyV4TailResealPlatform } from "../scripts/v4-tail-reseal.mjs";
import {
  V4_TAIL_RESEAL_REQUIRED_SUCCESS_JOBS,
  validateV4TailResealGitHubEvidence,
} from "../packages/core/v4-tail-reseal-github.js";
import { createReleaseCandidatePassport } from "../packages/core/release-candidate.js";
import {
  scanV4FloatingConsumerPolicy,
  v4ConsumerPolicyScannerRoot,
} from "../packages/core/v4-floating-consumer-policy.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(
      repositoryRoot,
      "contracts/fixtures/v4-tail-reseal-v1/valid.json",
    ),
    "utf8",
  ),
);
const schema = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "contracts/v4-tail-reseal-v1.schema.json"),
    "utf8",
  ),
);
const floatingPolicy = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "architecture/v4-floating-consumer-policy.json"),
    "utf8",
  ),
);

function mutate(callback) {
  const value = structuredClone(fixture);
  callback(value);
  return value;
}

function contractLock(ref, resolvedSha) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-contract-lock",
    buildchain: {
      ref,
      resolvedSha,
      contract: "kungfu-buildchain-runtime-contract-world",
      contractDigest: fixture.runtime.contractRoot,
      compatibilityDigest: fixture.runtime.contractRoot,
      majorLine: "v4",
      compatibilityPolicy: "major-compatible",
      acceptedAt: "2026-08-15T03:00:00.000Z",
      surfaces: [],
    },
  };
}

function consumerPolicyReceipt() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-tail-policy-"),
  );
  const workflow = path.join(root, ".github/workflows/build.yml");
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.writeFileSync(
    workflow,
    "jobs:\n  build:\n    uses: kungfu-systems/buildchain/.github/workflows/v4-stage-capsule-canary.yml@v4-alpha\n",
  );
  fs.mkdirSync(path.join(root, ".buildchain"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".buildchain/contract-lock.json"),
    `${JSON.stringify(contractLock("v4", "e".repeat(40)))}\n`,
  );
  fs.writeFileSync(
    path.join(root, ".buildchain/alpha-contract-lock.json"),
    `${JSON.stringify(contractLock("v4-alpha", fixture.runtime.sha))}\n`,
  );
  const result = scanV4FloatingConsumerPolicy({
    root,
    repository: fixture.repository,
    sourceSha: fixture.source.sha,
    invokedWorkflow: "v4-stage-capsule-canary.yml",
    expectedInvocationChannel: "alpha",
    resolvedRuntimeSha: fixture.runtime.sha,
    policy: floatingPolicy,
    scannerRoot: v4ConsumerPolicyScannerRoot(),
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.receiptRoot, fixture.runtime.consumerPolicyReceiptRoot);
  return { receipt: result.receipt, receiptRoot: result.receiptRoot };
}

function standardPassport() {
  const buildSummary = {
    contract: "kungfu-buildchain-artifact-summary",
    git: {
      repository: fixture.repository,
      sha: fixture.source.sha,
      treeSha: fixture.source.treeSha,
      runId: String(fixture.source.runId),
      runAttempt: String(fixture.source.runAttempt),
    },
    publishSource: {
      sha: fixture.source.sha,
      channel: fixture.target.channel,
      ref: fixture.target.ref,
      consumerVersion: fixture.target.version,
    },
    runtime: {
      ref: fixture.runtime.ref,
      sha: fixture.runtime.sha,
      workflowShellRef: "v4-alpha",
    },
    platforms: fixture.platforms.map((platform) => ({
      platform: { id: platform.id },
      artifactName: platform.artifactName,
      artifacts: [
        {
          name: `${platform.id}.bin`,
          path: `${platform.id}.bin`,
          size: 1,
          sha256: platform.artifactRoot.replace(/^sha256:/u, ""),
        },
      ],
      summary: { fileCount: 1, totalBytes: 1 },
      manifestPath: `${platform.id}/manifest.json`,
    })),
  };
  return createReleaseCandidatePassport({
    repository: fixture.repository,
    targetChannel: fixture.target.channel,
    version: fixture.target.version,
    sourceHeadSha: fixture.source.sha,
    baseSha: fixture.target.baseSha,
    mergeRefSha: fixture.source.sha,
    sourceTreeHash: fixture.source.treeSha,
    buildSummary,
    buildchain: {
      ref: fixture.runtime.ref,
      sha: fixture.runtime.sha,
      workflowShellRef: "v4-alpha",
    },
    consumerPolicyReceipt: consumerPolicyReceipt(),
    workflow: {
      name: "V4 tail reseal",
      runId: "9001",
      runAttempt: "1",
    },
    createdAt: fixture.evaluatedAt,
  });
}

function platformReadbacks() {
  return fixture.platforms.map((platform) =>
    platform.id === "macos-arm64"
      ? {
          platformId: platform.id,
          artifactRoot: `sha256:${"f".repeat(64)}`,
          manifestRoot: `sha256:${"e".repeat(64)}`,
          capsuleRoot: platform.capsuleRoot,
          byteIdentical: false,
          providerReadbackRoot: fixture.signing.providerReadbackRoot,
        }
      : {
          platformId: platform.id,
          artifactRoot: platform.artifactRoot,
          manifestRoot: platform.manifestRoot,
          capsuleRoot: platform.capsuleRoot,
          byteIdentical: true,
          providerReadbackRoot: null,
        },
  );
}

function writePlatform(root, request, platformId, payloadText) {
  const payload = path.join(root, "product", platformId, "payload.bin");
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.writeFileSync(payload, payloadText);
  const digest = `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(payload))
    .digest("hex")}`;
  const relative = path.relative(root, payload);
  const file = { path: relative, size: fs.statSync(payload).size, digest };
  const manifest = {
    contract: "kungfu-buildchain-artifact",
    artifactName: request.platforms.find(({ id }) => id === platformId)
      .artifactName,
    git: {
      repository: request.repository,
      sha: request.source.sha,
      treeSha: request.source.treeSha,
      runId: String(request.source.runId),
      runAttempt: String(request.source.runAttempt),
    },
    platform: { id: platformId, name: platformId },
    files: [
      {
        path: relative,
        size: file.size,
        sha256: digest.replace(/^sha256:/u, ""),
      },
    ],
    summary: { fileCount: 1, totalBytes: file.size },
  };
  const manifestPath = path.join(
    root,
    "manifests",
    platformId,
    "manifest.json",
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    artifactRoot: v4ContentRoot("tail-reseal-artifact-files", [file]),
    manifestRoot: `sha256:${crypto
      .createHash("sha256")
      .update(fs.readFileSync(manifestPath))
      .digest("hex")}`,
    payload,
  };
}

test("v4 tail-reseal fixture and planner bind the exact four-platform retained candidate", () => {
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  const normalized = normalizeV4TailResealRequest(fixture);
  const first = planV4TailReseal(normalized);
  const second = planV4TailReseal(structuredClone(fixture));
  assert.deepEqual(
    normalized.platforms.map(({ id }) => id),
    V4_TAIL_RESEAL_PLATFORMS,
  );
  assert.equal(first.planRoot, second.planRoot);
  assert.equal(first.productionAuthority, "v4");
  assert.equal(first.capsuleReuse.effectAuthority, "none");
  assert.equal(first.signingEffect.authority, "explicit-live-release-tail");
  assert.deepEqual(first.skippedStages, [
    "build",
    "install",
    "package",
    "platform-matrix",
    "verify",
  ]);
  assert.deepEqual(first.rerunStages, [
    "macos-signing-finalization",
    "aggregate",
    "candidate-passport",
    "protected-readback",
  ]);
});

test("tail reseal fails closed on every authority and identity boundary", () => {
  const cases = [
    ["source", mutate((value) => (value.source.sha = "f".repeat(39)))],
    [
      "artifact",
      mutate((value) => (value.platforms[0].artifactRoot = "stale")),
    ],
    [
      "manifest",
      mutate((value) => (value.platforms[1].manifestRoot = "stale")),
    ],
    [
      "platform",
      mutate(
        (value) =>
          ([value.platforms[0], value.platforms[1]] = [
            value.platforms[1],
            value.platforms[0],
          ]),
      ),
    ],
    ["signer", mutate((value) => (value.signing.runtimeSha = "e".repeat(40)))],
    ["Warrant", mutate((value) => (value.warrant.status = "expired"))],
    [
      "credential",
      mutate(
        (value) => (value.signing.credentialExpiresAt = value.evaluatedAt),
      ),
    ],
    [
      "retention",
      mutate((value) => (value.retention.retainUntil = value.evaluatedAt)),
    ],
    ["prior failure", mutate((value) => (value.failure.stage = "build"))],
  ];
  for (const [label, input] of cases) {
    assert.throws(
      () => planV4TailReseal(input),
      undefined,
      `${label} mismatch must fail closed`,
    );
  }
});

test("tail receipt permits only the explicit macOS byte change and embeds the standard v4 candidate Passport", () => {
  const passport = standardPassport();
  const receipt = createV4TailResealReceipt({
    request: fixture,
    plan: planV4TailReseal(fixture),
    readbacks: platformReadbacks(),
    passport,
    protectedReadbackRoot: `sha256:${"d".repeat(64)}`,
    currentRun: { id: 9001, attempt: 1 },
  });
  assert.equal(receipt.passport.contract, passport.contract);
  assert.equal(receipt.passport.candidateHash, passport.candidateHash);
  assert.equal(receipt.platformReadbacks[2].byteIdentical, false);
  assert.equal(
    verifyV4TailResealReceipt({ receipt, request: fixture, passport }).ok,
    true,
  );

  const changedLinux = platformReadbacks();
  changedLinux[0].artifactRoot = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () =>
      createV4TailResealReceipt({
        request: fixture,
        plan: planV4TailReseal(fixture),
        readbacks: changedLinux,
        passport,
        protectedReadbackRoot: `sha256:${"d".repeat(64)}`,
        currentRun: { id: 9001, attempt: 1 },
      }),
    /non-macOS retained artifacts must remain byte-identical/u,
  );
});

test("fresh-runner byte verification proves retained bytes and only accepts a read-back macOS reseal", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-tail-bytes-"),
  );
  const request = structuredClone(fixture);
  const retained = writePlatform(root, request, "macos-arm64", "unsigned");
  const platform = request.platforms.find(({ id }) => id === "macos-arm64");
  platform.artifactRoot = retained.artifactRoot;
  platform.manifestRoot = retained.manifestRoot;
  const before = verifyV4TailResealPlatform({
    request,
    platformId: "macos-arm64",
    artifactRoot: root,
    mode: "retained",
  });
  assert.equal(before.byteIdentical, true);

  writePlatform(root, request, "macos-arm64", "signed-and-notarized");
  const after = verifyV4TailResealPlatform({
    request,
    platformId: "macos-arm64",
    artifactRoot: root,
    mode: "resealed",
    providerReadbackRoot: request.signing.providerReadbackRoot,
  });
  assert.equal(after.byteIdentical, false);
  assert.notEqual(after.artifactRoot, before.artifactRoot);
  assert.throws(
    () =>
      verifyV4TailResealPlatform({
        request,
        platformId: "macos-arm64",
        artifactRoot: root,
        mode: "resealed",
        providerReadbackRoot: `sha256:${"0".repeat(64)}`,
      }),
    /provider readback root mismatch/u,
  );
});

test("GitHub admission readback binds archive digests and the single prior macOS failure", () => {
  const evidence = {
    request: fixture,
    sourceCommit: {
      sha: fixture.source.sha,
      tree: { sha: fixture.source.treeSha },
    },
    sourceRun: {
      id: fixture.source.runId,
      run_attempt: fixture.source.runAttempt,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      head_sha: fixture.source.sha,
      path: `.github/workflows/${fixture.source.workflowFile}@refs/heads/main`,
      name: fixture.source.workflowName,
    },
    sourceJobs: [
      ...V4_TAIL_RESEAL_REQUIRED_SUCCESS_JOBS.map((name, index) => ({
        id: index + 1,
        name,
        conclusion: "success",
        steps: [],
      })),
      {
        id: fixture.failure.jobId,
        name: fixture.failure.jobName,
        conclusion: "failure",
        steps: [{ name: fixture.failure.stepName, conclusion: "failure" }],
      },
    ],
    sourceArtifacts: fixture.platforms.flatMap((platform) => [
      {
        name: platform.artifactName,
        digest: platform.artifactArchiveRoot,
        expired: false,
      },
      {
        name: platform.manifestArtifactName,
        digest: platform.manifestArchiveRoot,
        expired: false,
      },
    ]),
    signingRun: {
      id: fixture.signing.authorityRunId,
      status: "completed",
      conclusion: "success",
      head_sha: fixture.signing.runtimeSha,
    },
    signingArtifacts: [
      {
        name: fixture.signing.resultArtifact,
        digest: fixture.signing.resultArtifactRoot,
        expired: false,
      },
    ],
  };
  const admission = validateV4TailResealGitHubEvidence(evidence);
  assert.match(admission.admissionRoot, /^sha256:[0-9a-f]{64}$/u);

  const stale = structuredClone(evidence);
  stale.sourceArtifacts[0].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => validateV4TailResealGitHubEvidence(stale),
    /archive digest drifted/u,
  );
  const extraFailure = structuredClone(evidence);
  extraFailure.sourceJobs.at(-1).steps.push({
    name: "Unexpected second failure",
    conclusion: "failure",
  });
  assert.throws(
    () => validateV4TailResealGitHubEvidence(extraFailure),
    /single authorized macOS tail failure/u,
  );
});
