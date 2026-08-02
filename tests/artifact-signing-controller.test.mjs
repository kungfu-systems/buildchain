import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactSigningCorrelation,
  assertArtifactSigningControllerReceipt,
  assertArtifactSigningControlRequestContext,
  createArtifactSigningControlRequest,
  readArtifactSigningControlRequest,
  sealArtifactSigningControlRequest,
  settleArtifactSigningControl,
  validateArtifactSigningControlRequest,
} from "../scripts/artifact-signing-controller.mjs";
import {
  dispatchArtifactSigningAuthority,
  validateArtifactSigningAuthorityRun,
} from "../scripts/dispatch-artifact-signing-authority.mjs";

const sourceSha = "1".repeat(40);
const treeSha = "2".repeat(40);
const runtimeSha = "3".repeat(40);
const requestDigest = `sha256:${"4".repeat(64)}`;

function fixture({
  requestCount = 1,
  sourceRunId = "100",
  sourceRunAttempt = 2,
} = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-signing-controller-"),
  );
  const indexPath = path.join(root, "index.json");
  fs.writeFileSync(
    indexPath,
    `${JSON.stringify({
      schemaVersion: 1,
      contract: "kungfu-buildchain-artifact-signing-request-index/v1",
      requests:
        requestCount === 0
          ? []
          : [
              {
                id: "consumer-cli",
                digest: requestDigest,
                path: "cli/request.json",
                required: true,
              },
            ],
    })}\n`,
  );
  const values = {
    sourceRepository: "kungfu-systems/consumer",
    sourceRunId,
    sourceRunAttempt,
    sourceSha,
    sourceTreeSha: treeSha,
    runtimeRepository: "kungfu-systems/buildchain",
    runtimeRef: "authority/v3/v3.0/artifact-signing",
    runtimeSha,
    platformId: "macos-arm64",
    platformName: "macOS ARM64",
    requestCount,
    requestArtifact:
      requestCount === 0
        ? ""
        : `consumer-signing-request-macos-arm64-${sourceSha}-${sourceRunId}-${sourceRunAttempt}`,
    requestIndexPath: indexPath,
    authorityRepository: "kungfu-systems/buildchain",
    resultArtifact:
      requestCount === 0
        ? ""
        : `consumer-signing-result-macos-arm64-${sourceSha}-${sourceRunId}-${sourceRunAttempt}`,
    artifactName: `consumer-macos-arm64-${sourceSha}`,
    manifestArtifact: `consumer-manifest-macos-arm64-${sourceSha}`,
    diagnosticsArtifact: `consumer-diagnostics-macos-arm64-${sourceSha}`,
    workingDirectory: ".",
    sealedAt: "2026-08-03T00:00:00.000Z",
  };
  return { root, indexPath, values };
}

test("seals an immutable run-attempt-bound signing control request", () => {
  const value = fixture({ sourceRunAttempt: 3 });
  try {
    const outputPath = path.join(value.root, "request.json");
    const sealed = sealArtifactSigningControlRequest({
      outputPath,
      ...value.values,
    });
    assert.deepEqual(readArtifactSigningControlRequest(outputPath), sealed);
    assert.equal(sealed.source.runAttempt, 3);
    assert.match(sealed.request.root, /^sha256:[0-9a-f]{64}$/u);
    assert.match(sealed.authority.correlationId, /^100-3-/u);
    assert.deepEqual(
      assertArtifactSigningControlRequestContext(sealed, {
        sourceRepository: "kungfu-systems/consumer",
        sourceRunId: "100",
        sourceRunAttempt: "3",
        sourceSha,
        sourceTreeSha: treeSha,
        runtimeRepository: "kungfu-systems/buildchain",
        runtimeSha,
        platformId: "macos-arm64",
      }),
      sealed,
    );
    assert.throws(
      () =>
        assertArtifactSigningControlRequestContext(sealed, {
          sourceRunAttempt: "2",
        }),
      /source run attempt mismatch/u,
    );
    assert.throws(
      () =>
        validateArtifactSigningControlRequest({
          ...sealed,
          sealedAt: "2026-08-03",
        }),
      /canonical ISO timestamp/u,
    );
    assert.throws(
      () =>
        validateArtifactSigningControlRequest({
          ...sealed,
          authority: { ...sealed.authority, correlationId: "foreign" },
        }),
      /correlation mismatch/u,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("independent source runs and reruns receive independent correlations", () => {
  const common = {
    runtimeSha,
    platformId: "macos-arm64",
    requestRoot: `sha256:${"a".repeat(64)}`,
  };
  const first = artifactSigningCorrelation({
    ...common,
    sourceRunId: "100",
    sourceRunAttempt: 1,
  });
  const rerun = artifactSigningCorrelation({
    ...common,
    sourceRunId: "100",
    sourceRunAttempt: 2,
  });
  const concurrent = artifactSigningCorrelation({
    ...common,
    sourceRunId: "101",
    sourceRunAttempt: 1,
  });
  assert.notEqual(first, rerun);
  assert.notEqual(first, concurrent);
  assert.notEqual(rerun, concurrent);
});

test("successful Linux controller settlement binds request, receipt, and delegation", () => {
  const value = fixture();
  try {
    const request = createArtifactSigningControlRequest(value.values);
    const receiptPath = path.join(value.root, "receipt.json");
    const delegationPath = path.join(value.root, "delegation.json");
    const settled = settleArtifactSigningControl({
      request,
      authorityStatus: "succeeded",
      authorityRunId: "900",
      authorityRunUrl:
        "https://github.com/kungfu-systems/buildchain/actions/runs/900",
      authorityResultArtifact: request.authority.resultArtifact,
      authorityCorrelationId: request.authority.correlationId,
      authorityConclusion: "success",
      controllerRepository: "kungfu-systems/consumer",
      controllerRunId: "100",
      controllerRunAttempt: 2,
      controllerJob: "artifact-signing-control",
      controllerRunnerOs: "Linux",
      controllerStartedAt: "2026-08-03T00:01:00.000Z",
      controllerCompletedAt: "2026-08-03T00:03:00.000Z",
      receiptPath,
      delegationPath,
    });
    assert.equal(settled.receipt.qualifying, true);
    assert.equal(settled.delegation.controller.mode, "detached");
    assert.equal(
      settled.delegation.controller.receiptDigest,
      settled.receipt.digest,
    );
    assert.deepEqual(
      assertArtifactSigningControllerReceipt({
        request,
        receipt: settled.receipt,
        delegation: settled.delegation,
      }),
      {
        request,
        receipt: settled.receipt,
        delegation: settled.delegation,
      },
    );
    const foreign = structuredClone(settled.delegation);
    foreign.authority.runId = "901";
    assert.throws(
      () =>
        assertArtifactSigningControllerReceipt({
          request,
          receipt: settled.receipt,
          delegation: foreign,
        }),
      /authority run ID mismatch/u,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("no-signing settlement skips authority without weakening finalization", () => {
  const value = fixture({ requestCount: 0 });
  try {
    const request = createArtifactSigningControlRequest(value.values);
    const settled = settleArtifactSigningControl({
      request,
      authorityStatus: "skipped",
      authorityConclusion: "not-required",
      controllerRepository: "kungfu-systems/consumer",
      controllerRunId: "100",
      controllerRunAttempt: 2,
      controllerRunnerOs: "Linux",
      controllerStartedAt: "2026-08-03T00:01:00.000Z",
      controllerCompletedAt: "2026-08-03T00:01:00.000Z",
      receiptPath: path.join(value.root, "receipt.json"),
      delegationPath: path.join(value.root, "delegation.json"),
    });
    assert.equal(settled.receipt.controller.status, "skipped");
    assert.equal(settled.receipt.authority.runId, "");
    assert.equal(settled.delegation.request.count, 0);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

for (const status of ["failed", "timed-out", "cancelled"]) {
  test(`${status} authority settlement is retained but cannot finalize`, () => {
    const value = fixture();
    try {
      const request = createArtifactSigningControlRequest(value.values);
      const delegationPath = path.join(value.root, "delegation.json");
      const settled = settleArtifactSigningControl({
        request,
        authorityStatus: status,
        authorityConclusion: status,
        authorityCorrelationId: request.authority.correlationId,
        authorityResultArtifact: request.authority.resultArtifact,
        controllerRepository: "kungfu-systems/consumer",
        controllerRunId: "100",
        controllerRunAttempt: 2,
        controllerRunnerOs: "Linux",
        controllerStartedAt: "2026-08-03T00:01:00.000Z",
        controllerCompletedAt: "2026-08-03T00:02:00.000Z",
        receiptPath: path.join(value.root, "receipt.json"),
        delegationPath,
      });
      assert.equal(settled.receipt.qualifying, false);
      assert.equal(settled.delegation, null);
      assert.equal(fs.existsSync(delegationPath), false);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });
}

test("dispatch accepts only the exact fresh authority run and exact runtime SHA", async () => {
  const correlationId = "100-2-333333333333-macos-arm64-aaaaaaaaaaaa";
  const expectedTitle = `Sign kungfu-systems/consumer run 100 (${correlationId})`;
  const run = {
    id: 900,
    display_title: expectedTitle,
    event: "workflow_dispatch",
    head_sha: runtimeSha,
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/kungfu-systems/buildchain/actions/runs/900",
    created_at: "2026-08-03T00:00:00.000Z",
    path: ".github/workflows/artifact-signing-authority.yml@refs/heads/authority/v3/v3.0/artifact-signing",
    repository: { full_name: "kungfu-systems/buildchain" },
  };
  let dispatches = 0;
  const result = await dispatchArtifactSigningAuthority({
    token: "test-token",
    authorityRepository: "kungfu-systems/buildchain",
    authorityRef: runtimeSha,
    sourceRepository: "kungfu-systems/consumer",
    sourceRunId: "100",
    sourceRunAttempt: "2",
    requestArtifact: `consumer-signing-request-${sourceSha}-100-2`,
    requestRoot: `sha256:${"a".repeat(64)}`,
    runtimeSha,
    resultArtifact: `consumer-signing-result-${sourceSha}-100-2`,
    correlationId,
    timeoutSeconds: "60",
    nowImpl: () => Date.parse("2026-08-03T00:00:10.000Z"),
    delayImpl: async () => {},
    requestImpl: async (_url, options) => {
      if (options.method === "POST") {
        dispatches += 1;
        assert.equal(options.body.inputs["source-run-attempt"], "2");
        assert.equal(
          options.body.inputs["expected-request-root"],
          `sha256:${"a".repeat(64)}`,
        );
        return {};
      }
      return { workflow_runs: [run] };
    },
  });
  assert.equal(dispatches, 1);
  assert.equal(result.runId, 900);
  assert.equal(result.status, "succeeded");
  assert.throws(
    () =>
      validateArtifactSigningAuthorityRun(
        { ...run, head_sha: "5".repeat(40) },
        {
          authorityRepository: "kungfu-systems/buildchain",
          runtimeSha,
          expectedTitle,
        },
      ),
    /runtime SHA mismatch/u,
  );
  assert.throws(
    () =>
      validateArtifactSigningAuthorityRun(
        { ...run, display_title: `${expectedTitle} foreign` },
        {
          authorityRepository: "kungfu-systems/buildchain",
          runtimeSha,
          expectedTitle,
        },
      ),
    /correlation mismatch/u,
  );
});

test("dispatch rejects duplicate exact correlations instead of choosing a run", async () => {
  const correlationId = "100-2-333333333333-macos-arm64-aaaaaaaaaaaa";
  const title = `Sign kungfu-systems/consumer run 100 (${correlationId})`;
  const run = {
    id: 900,
    display_title: title,
    event: "workflow_dispatch",
    head_sha: runtimeSha,
    status: "queued",
    conclusion: null,
    html_url: "https://github.com/kungfu-systems/buildchain/actions/runs/900",
    created_at: "2026-08-03T00:00:00.000Z",
  };
  await assert.rejects(
    () =>
      dispatchArtifactSigningAuthority({
        token: "test-token",
        authorityRepository: "kungfu-systems/buildchain",
        authorityRef: runtimeSha,
        sourceRepository: "kungfu-systems/consumer",
        sourceRunId: "100",
        sourceRunAttempt: "2",
        requestArtifact: "consumer-request-100-2",
        requestRoot: `sha256:${"a".repeat(64)}`,
        runtimeSha,
        resultArtifact: "consumer-result-100-2",
        correlationId,
        timeoutSeconds: "60",
        nowImpl: () => Date.parse("2026-08-03T00:00:10.000Z"),
        delayImpl: async () => {},
        requestImpl: async (_url, options) =>
          options.method === "POST"
            ? {}
            : { workflow_runs: [run, { ...run, id: 901 }] },
      }),
    /multiple Buildchain signing authority runs/u,
  );
});
