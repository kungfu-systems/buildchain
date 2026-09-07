import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  bridgeBinary,
  buildBridge,
  createHostRequest,
  runBridge,
} from "../scripts/bridge-bootstrap.mjs";

const root = path.resolve(import.meta.dirname, "..");
const architectureScript = path.join(root, "scripts", "architecture.mjs");
const hostScript = path.join(root, "scripts", "host-adapter.mjs");

function ensureBridge() {
  if (fs.existsSync(bridgeBinary())) return;
  const result = buildBridge();
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function exchange(request, options = {}) {
  ensureBridge();
  const result = runBridge(request, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Rust bridge preserves representative architecture CLI stdout and exit behavior", () => {
  ensureBridge();
  const direct = execFileSync(
    process.execPath,
    [architectureScript, "list", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  const request = createHostRequest({
    command: "architecture.list",
    args: ["--json"],
    requiredCapabilities: ["architecture-read-v1", "structured-result-v1"],
  });
  const bridged = runBridge(request, { mode: "compat", encoding: "utf8" });
  assert.equal(bridged.status, 0, bridged.stderr);
  assert.equal(bridged.stdout, direct);

  const directFailure = spawnSync(
    process.execPath,
    [architectureScript, "show", "missing", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  const bridgeFailure = runBridge(
    createHostRequest({
      command: "architecture.show",
      args: ["missing", "--json"],
    }),
    { mode: "compat", encoding: "utf8" },
  );
  assert.equal(bridgeFailure.status, directFailure.status);
  assert.equal(bridgeFailure.stdout, directFailure.stdout);
  assert.equal(bridgeFailure.stderr, directFailure.stderr);
});

test("host contract preserves structured JSON, controlled failure, and bounded large input", () => {
  const architecture = exchange(
    createHostRequest({
      command: "architecture.show",
      args: ["publish-transaction", "--json"],
    }),
  );
  assert.equal(architecture.status, "ok");
  assert.equal(
    architecture.structuredResult.capability.id,
    "publish-transaction",
  );

  const failure = exchange(createHostRequest({ command: "fixture.fail" }));
  assert.equal(failure.status, "failed");
  assert.equal(failure.exit.code, 42);
  assert.equal(
    Buffer.from(failure.output.stdout.bytes, "base64").toString("utf8"),
    "partial-output\n",
  );
  assert.equal(
    Buffer.from(failure.output.stderr.bytes, "base64").toString("utf8"),
    "controlled fixture failure\n",
  );

  const input = Buffer.alloc(512 * 1024, "bounded-payload");
  const echo = exchange(
    createHostRequest({ command: "fixture.echo", input, timeoutMs: 10000 }),
  );
  assert.equal(echo.status, "ok");
  assert.deepEqual(Buffer.from(echo.output.stdout.bytes, "base64"), input);
  assert.equal(echo.structuredResult.bytes, input.length);
});

test("capability negotiation and private-field rejection fail closed", () => {
  const unsupported = exchange(
    createHostRequest({
      command: "architecture.list",
      requiredCapabilities: ["future-private-runtime-layout-v9"],
    }),
  );
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.exit.code, 64);
  assert.equal(unsupported.diagnostics[0].code, "unsupported-capability");

  ensureBridge();
  const request = {
    ...createHostRequest({ command: "fixture.echo" }),
    credentials: { token: "must-not-cross-the-contract" },
  };
  const rejected = spawnSync(bridgeBinary(), ["exchange"], {
    cwd: root,
    input: JSON.stringify(request),
    encoding: "utf8",
  });
  assert.equal(rejected.status, 65);
  assert.match(rejected.stderr, /unknown field `credentials`/);
  assert.doesNotMatch(rejected.stderr, /must-not-cross-the-contract/);
});

test("the checked-in evaluation keeps the host replaceable and writer authority on v3", () => {
  const evaluation = JSON.parse(
    fs.readFileSync(
      path.join(root, "architecture", "rust-libnode-bridge-evaluation.json"),
      "utf8",
    ),
  );
  assert.equal(evaluation.selection.status, "selected-for-wave-0");
  assert.equal(evaluation.selection.replaceable, true);
  assert.equal(evaluation.selection.productionWriterAuthority, "typescript-v3");
  assert.equal(
    evaluation.options.find(
      (entry) => entry.id === "rust-process-direct-libnode-cxx-api",
    ).prototypeDisposition,
    "source-grounded-infeasibility",
  );
  assert.match(
    evaluation.options.find(
      (entry) => entry.id === "rust-trunk-node-subprocess-host-v1",
    ).replacementMechanism,
    /BUILDCHAIN_V4_HOST_COMMAND/,
  );
});

test("timeout and host crash are classified and the child is reaped", () => {
  const timeout = exchange(
    createHostRequest({
      command: "fixture.wait",
      args: ["10000"],
      timeoutMs: 75,
    }),
  );
  assert.equal(timeout.status, "cancelled");
  assert.equal(timeout.exit.code, 124);
  assert.equal(timeout.diagnostics[0].code, "host-timeout");
  assert.match(timeout.diagnostics[0].message, /terminated and reaped/);

  const crash = exchange(createHostRequest({ command: "fixture.crash" }));
  assert.equal(crash.status, "failed");
  assert.equal(crash.exit.code, 86);
  assert.equal(crash.diagnostics[0].code, "host-crashed");
});

test(
  "SIGINT cancellation produces a structured result after reaping the host",
  { skip: process.platform === "win32" },
  async () => {
    ensureBridge();
    const request = createHostRequest({
      command: "fixture.wait",
      args: ["10000"],
      timeoutMs: 20000,
    });
    const child = spawn(bridgeBinary(), ["exchange"], {
      cwd: root,
      env: {
        ...process.env,
        BUILDCHAIN_V4_HOST_COMMAND: process.execPath,
        BUILDCHAIN_V4_HOST_SCRIPT: hostScript,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(JSON.stringify(request));
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill("SIGINT");
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "cancelled");
    assert.equal(result.exit.code, 130);
    assert.equal(result.exit.signal, "SIGINT");
    assert.match(result.diagnostics[0].message, /terminated and reaped/);
  },
);
