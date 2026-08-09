import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KFD_AGENT_HUB_ADOPTION_CONTRACT,
  explainKfdAgentHub,
  initKfdAgentHub,
  inspectKfdAgentHub,
  testKfdAgentHub,
} from "../packages/core/kfd-agent-hub.js";
import {
  resolveSpawnCommand,
  spawnSyncCommand,
  usesShellForSpawnCommand,
} from "../packages/core/spawn-command.js";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function root(character) {
  return `sha256:${character.repeat(64)}`;
}

function digest(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function semanticRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(`${stableJson(value)}\n`).digest("hex")}`;
}

function fixture() {
  const cwd = tempDir("kfd-agent-hub");
  const kfdRoot = path.join(cwd, "node_modules", "@kungfu-tech", "kfd");
  const adapterPath = path.join(cwd, "dist", "agent-hub-adapter.mjs");
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, "export const adapter = true;\n");
  writeJson(path.join(kfdRoot, "package.json"), {
    name: "@kungfu-tech/kfd",
    version: "1.0.0-alpha.99",
    bin: { kfd: "bin/kfd.mjs" },
  });
  fs.mkdirSync(path.join(kfdRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(kfdRoot, "bin", "kfd.mjs"), "// fixture\n");
  fs.mkdirSync(path.join(kfdRoot, "scripts"), { recursive: true });
  const verifierPath = path.join(kfdRoot, "scripts", "agent-hub-report-verifier.mjs");
  fs.writeFileSync(verifierPath, "// fixture verifier\n");
  const protocolPath = writeJson(path.join(kfdRoot, "protocols", "agent-hub", "manifest.json"), { contract: "fixture.protocol/v1" });
  const runtimePath = writeJson(path.join(kfdRoot, "profiles", "agent-runtime", "manifest.json"), { contract: "fixture.runtime/v1" });
  const vectorsPath = writeJson(path.join(kfdRoot, "profiles", "agent-hub", "vectors", "hub-20.json"), { contract: "fixture.vectors/v1", vectors: Array.from({ length: 20 }, (_, id) => ({ id })) });
  const failuresPath = writeJson(path.join(kfdRoot, "profiles", "agent-hub", "failure-codes.json"), { contract: "fixture.failures/v1" });
  const profilePath = writeJson(path.join(kfdRoot, "profiles", "agent-hub", "manifest.json"), {
    schemaVersion: 1,
    contract: "kfd.agent-hub-conformance-manifest/v1",
    profile: { id: "kfd-agent-hub-conformance", version: "0.1.0-alpha.1" },
    protocol: { id: "kfd-agent-hub", version: "0.1.0-alpha.1", manifest: "protocols/agent-hub/manifest.json", manifestDigest: digest(protocolPath) },
    suite: { id: "kfd-agent-hub-20", version: "0.1.0-alpha.1", fixedVectorCount: 20, vectorRoot: digest(vectorsPath) },
    adapter: { binding: "jsonl-stdio/v1" },
    failureInventory: { path: "profiles/agent-hub/failure-codes.json", root: digest(failuresPath) },
    runtimeDependency: { id: "kfd-runtime-100", version: "0.1.0-alpha.1", manifest: "profiles/agent-runtime/manifest.json", manifestDigest: digest(runtimePath), coreVectorCount: 35, experimentalVectorCount: 65, qualifying: false },
    claimBoundary: "Exact adapter evidence only; not certification.",
  });
  const releasePath = writeJson(path.join(kfdRoot, "kfd.release.json"), { contract: "fixture.release/v1" });
  const declarationPath = writeJson(path.join(cwd, ".buildchain", "kfd", "agent-hub.json"), {
    schemaVersion: 1,
    contract: KFD_AGENT_HUB_ADOPTION_CONTRACT,
    profile: { package: "@kungfu-tech/kfd", id: "kfd-agent-hub-conformance" },
    adapter: { id: "fixture-adapter", version: "0.1.0", path: "dist/agent-hub-adapter.mjs" },
    capabilities: {
      operations: ["capability-advertisement", "fact-admission"],
      topologies: ["local-peer"],
      hubBindings: ["local-file-bundle"],
    },
  });
  const capability = {
    operations: ["fact-admission", "capability-advertisement"],
    topologies: ["local-peer"],
    bindings: [{ id: "local-file-bundle" }],
  };
  const report = {
    contract: "kfd.agent-hub-report/v1",
    sourceCut: {
      package: "@kungfu-tech/kfd",
      packageVersion: "1.0.0-alpha.99",
      packageManifestDigest: digest(path.join(kfdRoot, "package.json")),
      releaseAnchorDigest: digest(releasePath),
    },
    profile: { manifestDigest: digest(profilePath) },
    protocol: { manifestDigest: digest(protocolPath) },
    suite: { vectorRoot: digest(vectorsPath), inventoryRoot: digest(failuresPath) },
    verifier: { failureInventoryRoot: digest(failuresPath), artifactDigest: digest(verifierPath) },
    adapter: { id: "fixture-adapter", version: "0.1.0", artifactDigest: digest(adapterPath) },
    capabilities: [
      { hubId: "hub-a", document: capability },
      { hubId: "hub-b", document: capability },
    ],
    execution: { offline: true },
    valid: true,
    qualifying: false,
    certification: false,
    residualRisk: ["fixture-only"],
  };
  return { cwd, kfdRoot, adapterPath, declarationPath, report };
}

test("init emits one declaration without overwriting by default", () => {
  const cwd = tempDir("kfd-agent-hub-init");
  const result = initKfdAgentHub({ cwd, write: true });
  assert.equal(result.write, true);
  assert.equal(result.declaration.contract, KFD_AGENT_HUB_ADOPTION_CONTRACT);
  assert.throws(() => initKfdAgentHub({ cwd, write: true }), /declaration-exists/);
});

test("default runner invokes Windows package-manager shims through explicit cmd quoting", () => {
  const calls = [];
  const result = spawnSyncCommand("npm", ["run", "build", '{"Key":"value with space"}'], { cwd: "C:\\agent-hub" }, {
    platform: "win32",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(result.status, 0);
  assert.equal(calls[0].command, "cmd.exe");
  assert.deepEqual(calls[0].args, ["/d", "/s", "/c", 'npm.cmd run build "{\\"Key\\":\\"value with space\\"}"']);
  assert.equal(calls[0].options.cwd, "C:\\agent-hub");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
});

test("default runner resolves arbitrary Windows command shims from PATH", () => {
  const bin = tempDir("windows-command-shim");
  fs.writeFileSync(path.join(bin, "gh.cmd"), "@echo off\r\n");
  const env = { PATH: bin };

  assert.equal(resolveSpawnCommand("gh", "win32", env), "gh.cmd");
  assert.equal(usesShellForSpawnCommand("gh", "win32", env), true);
  assert.equal(resolveSpawnCommand("aws", "win32", env), "aws");
  assert.equal(usesShellForSpawnCommand("aws", "win32", env), false);
});

test("inspect locks the exact KFD package, profile, suite, and adapter artifact", () => {
  const value = fixture();
  const result = inspectKfdAgentHub({ cwd: value.cwd, kfdRoot: value.kfdRoot });
  assert.equal(result.valid, true);
  assert.equal(result.lock.sourceCut.package.version, "1.0.0-alpha.99");
  assert.equal(result.lock.sourceCut.suite.vectorRoot, digest(path.join(value.kfdRoot, "profiles", "agent-hub", "vectors", "hub-20.json")));
  assert.equal(result.lock.sourceCut.runtimeDependency.id, "kfd-runtime-100");
  assert.equal(result.lock.adapter.artifactDigest, digest(value.adapterPath));
  assert.equal(result.lock.adapter.invocationBinding, "jsonl-stdio/v1");
  assert.deepEqual(result.lock.capabilities.hubBindings, ["local-file-bundle"]);
  assert.match(result.lock.lockRoot, /^sha256:[0-9a-f]{64}$/);
});

test("CLI exposes init and agent-readable inspect without a consumer verifier command", () => {
  const value = fixture();
  const cli = path.resolve("bin/buildchain.mjs");
  const result = spawnSync(process.execPath, [cli, "kfd", "hub", "inspect", "--cwd", value.cwd, "--for", "agent"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const inspection = JSON.parse(result.stdout);
  assert.equal(inspection.valid, true);
  assert.equal(inspection.lock.sourceCut.package.version, "1.0.0-alpha.99");
  assert.doesNotMatch(fs.readFileSync(cli, "utf8"), /kfd hub.*verify-command/);
});

test("test delegates semantics to KFD and writes portable evidence", () => {
  const value = fixture();
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args.includes("test")) {
      const outputIndex = args.indexOf("--output");
      writeJson(args[outputIndex + 1], value.report);
      return { status: 0, stdout: "", stderr: "" };
    }
    return {
      status: 0,
      stdout: `${JSON.stringify({ contract: "kfd.agent-hub-report-verifier/v1", valid: true, checks: [], issues: [], reportDigest: semanticRoot(value.report) })}\n`,
      stderr: "",
    };
  };
  const result = testKfdAgentHub({ cwd: value.cwd, kfdRoot: value.kfdRoot, run });
  assert.equal(result.valid, true);
  assert.deepEqual(calls.map((args) => args.slice(1, 3)), [["test", "agent-hub"], ["verify", "agent-hub-report"]]);
  for (const name of ["report.json", "verification.json", "adoption-lock.json", "evidence.json"]) {
    assert.equal(fs.existsSync(path.join(value.cwd, ".buildchain", "artifacts", "kfd-agent-hub", name)), true, name);
  }
  assert.equal(testKfdAgentHub({ cwd: value.cwd, kfdRoot: value.kfdRoot, run }).valid, true);
  assert.deepEqual(
    fs.readdirSync(path.join(value.cwd, ".buildchain", "artifacts", "kfd-agent-hub")).filter((name) => name.startsWith(".report-")),
    [],
  );
});

test("test fails when observed capabilities widen beyond the declaration", () => {
  const value = fixture();
  value.report.capabilities[1].document = {
    ...value.report.capabilities[1].document,
    operations: [...value.report.capabilities[1].document.operations, "supersession"],
  };
  const run = (_command, args) => {
    if (args.includes("test")) {
      writeJson(args[args.indexOf("--output") + 1], value.report);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: JSON.stringify({ contract: "kfd.agent-hub-report-verifier/v1", valid: true, reportDigest: semanticRoot(value.report) }), stderr: "" };
  };
  assert.throws(() => testKfdAgentHub({ cwd: value.cwd, kfdRoot: value.kfdRoot, run }), /capability-declaration-mismatch/);
});

test("explain identifies an unavailable KFD profile as the blocking layer", () => {
  const value = fixture();
  fs.rmSync(path.join(value.kfdRoot, "profiles", "agent-hub", "vectors", "hub-20.json"));
  const explanation = explainKfdAgentHub({ cwd: value.cwd, kfdRoot: value.kfdRoot });
  assert.equal(explanation.status, "blocked");
  assert.equal(explanation.owner, "KFD package");
  assert.match(explanation.nextAction, /profile-unavailable/);
});
