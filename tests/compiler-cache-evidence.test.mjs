import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUILDCHAIN_COMPILER_CACHE_PREPARATION_CONTRACT,
  prepareCompilerCacheEvidence,
} from "../scripts/compiler-cache-evidence.mjs";
import { createStructuredCacheEvidence } from "../packages/core/diagnostics.js";

function commandResult(stdout = "") {
  return {
    status: 0,
    signal: null,
    stdout,
    stderr: "",
  };
}

test("sccache preparation resets only current-run stats and writes a source-bound receipt", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-sccache-prepare-"));
  const githubEnv = path.join(workspace, "github-env");
  const calls = [];
  try {
    const toolEvidence = {
      schemaVersion: 1,
      contract: "kungfu-windows-sccache-tool",
      version: "0.16.0",
      root: `sha256:${"1".repeat(64)}`,
    };
    const toolEvidencePath = path.join(
      workspace,
      ".buildchain/diagnostics/sccache-tool.json",
    );
    fs.mkdirSync(path.dirname(toolEvidencePath), { recursive: true });
    fs.writeFileSync(toolEvidencePath, `${JSON.stringify(toolEvidence)}\n`);
    const receipt = prepareCompilerCacheEvidence({
      cwd: workspace,
      env: {
        BUILDCHAIN_COMPILER_CACHE_PROVIDER: "sccache",
        BUILDCHAIN_COMPILER_CACHE_REQUIRED: "true",
        BUILDCHAIN_COMPILER_CACHE_PREPARATION_PATH:
          ".buildchain/diagnostics/compiler-cache-preparation.json",
        BUILDCHAIN_COMPILER_CACHE_TOOL_ROOT: `sha256:${"1".repeat(64)}`,
        BUILDCHAIN_COMPILER_CACHE_TOOL_EVIDENCE_PATH:
          ".buildchain/diagnostics/sccache-tool.json",
        BUILDCHAIN_SOURCE_SHA: "a".repeat(40),
        BUILDCHAIN_SOURCE_TREE_SHA: "b".repeat(40),
        BUILDCHAIN_RUNTIME_SHA: "c".repeat(40),
        BUILDCHAIN_PLATFORM_ID: "windows-x64",
        RUNNER_OS: "Windows",
        RUNNER_ARCH: "X64",
        SHIFU_CACHE_PROFILE_DIGEST: `sha256:${"2".repeat(64)}`,
        GITHUB_ENV: githubEnv,
      },
      runCommand(command, args) {
        calls.push([command, ...args]);
        return args[0] === "--version"
          ? commandResult("sccache 0.16.0\n")
          : commandResult("Compile requests                      0\n");
      },
      now: () => new Date("2026-07-31T00:00:00.000Z"),
    });
    assert.deepEqual(calls, [
      ["sccache", "--version"],
      ["sccache", "--zero-stats"],
    ]);
    assert.equal(receipt.contract, BUILDCHAIN_COMPILER_CACHE_PREPARATION_CONTRACT);
    assert.equal(receipt.provider, "sccache");
    assert.equal(receipt.action.statsReset, true);
    assert.equal(receipt.bindings.sourceCommit, "a".repeat(40));
    assert.equal(receipt.bindings.cacheProfileRoot, `sha256:${"2".repeat(64)}`);
    assert.equal(receipt.tool.evidenceRoot, `sha256:${"1".repeat(64)}`);
    assert.deepEqual(receipt.tool.evidence, toolEvidence);
    assert.match(receipt.root, /^sha256:[0-9a-f]{64}$/);
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(workspace, ".buildchain/diagnostics/compiler-cache-preparation.json"),
        "utf8",
      ),
    );
    assert.deepEqual(persisted, receipt);
    const exported = fs.readFileSync(githubEnv, "utf8");
    assert.match(exported, /BUILDCHAIN_COMPILER_CACHE_ACTIVE_PROVIDER=sccache/);
    assert.match(exported, new RegExp(`BUILDCHAIN_COMPILER_CACHE_PREPARATION_ROOT=${receipt.root}`));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("required preparation fails closed when sccache is unavailable", () => {
  assert.throws(
    () =>
      prepareCompilerCacheEvidence({
        env: {
          BUILDCHAIN_COMPILER_CACHE_PROVIDER: "sccache",
          BUILDCHAIN_COMPILER_CACHE_REQUIRED: "true",
          BUILDCHAIN_SOURCE_SHA: "a".repeat(40),
        },
        runCommand() {
          return {
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("not found"), { code: "ENOENT" }),
          };
        },
      }),
    /sccache version probe failed: ENOENT/,
  );
});

test("structured evidence admits sccache outcomes only with a current-run reset receipt", () => {
  const preparation = {
    schemaVersion: 1,
    contract: BUILDCHAIN_COMPILER_CACHE_PREPARATION_CONTRACT,
    provider: "sccache",
    status: "prepared",
    action: { statsReset: true },
    root: `sha256:${"3".repeat(64)}`,
  };
  const compilerCaches = {
    ccache: {
      available: false,
      logStats: { available: false },
    },
    sccache: {
      available: true,
      stats: {
        stats: {
          compile_requests: 12,
          cache_hits: { C: 3, Cxx: 4 },
          cache_misses: 5,
        },
      },
    },
  };
  const admitted = createStructuredCacheEvidence({
    compilerCaches,
    compilerCachePreparation: preparation,
    platform: "windows-x64",
    env: {
      GITHUB_REPOSITORY: "kungfu-systems/kungfu",
      BUILDCHAIN_SOURCE_SHA: "a".repeat(40),
    },
  });
  const operation = admitted.operations.find(
    (entry) => entry.operationId === "compiler-cache:windows-x64",
  );
  assert.equal(operation.provider, "sccache");
  assert.equal(operation.producer, "sccache");
  assert.equal(operation.outcome, "partial");
  assert.equal(
    operation.bindings.compilerCachePreparationRoot,
    preparation.root,
  );
  assert.equal(operation.metrics.lookupDuration.source, "sccache-current-run-stats");

  const cumulativeOnly = createStructuredCacheEvidence({
    compilerCaches,
    platform: "windows-x64",
    env: {
      GITHUB_REPOSITORY: "kungfu-systems/kungfu",
      BUILDCHAIN_SOURCE_SHA: "a".repeat(40),
    },
  });
  const rejected = cumulativeOnly.operations.find(
    (entry) => entry.operationId === "compiler-cache:windows-x64",
  );
  assert.equal(rejected.provider, "sccache");
  assert.equal(rejected.producer, "unavailable");
  assert.equal(rejected.outcome, "unavailable");
  assert.match(
    rejected.metrics.lookupDuration.reason,
    /not admitted without a current-run reset preparation receipt/,
  );
});
