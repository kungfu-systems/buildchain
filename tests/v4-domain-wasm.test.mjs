import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  V4_DOMAIN_WASM_ABI_VERSION,
  V4_DOMAIN_WASM_SHA256,
} from "../packages/core/v4-domain-wasm-artifact.js";
import {
  V4_DOMAIN_WASM_REQUEST_CONTRACT,
  V4_DOMAIN_WASM_RESPONSE_CONTRACT,
  v4DomainWasmInfo,
} from "../packages/core/v4-domain-wasm.js";
import { spawnSyncCommand } from "../packages/core/spawn-command.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDirectory = path.join(root, "packages", "core");
const artifactPath = path.join(coreDirectory, "buildchain-v4-domain.wasm");
const actionArtifacts = [
  "actions/promote-buildchain-ref/dist/buildchain-v4-domain.wasm",
  "actions/release-tail/dist/buildchain-v4-domain.wasm",
  "actions/v4-release-candidate-promote/dist/buildchain-v4-domain.wasm",
];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function copyAuthority(directory, { tamper = false, omit = false } = {}) {
  fs.writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ type: "module" })}\n`,
  );
  for (const name of ["v4-domain-wasm.js", "v4-domain-wasm-artifact.js"]) {
    fs.copyFileSync(path.join(coreDirectory, name), path.join(directory, name));
  }
  if (!omit) {
    const bytes = fs.readFileSync(artifactPath);
    if (tamper) bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(path.join(directory, "buildchain-v4-domain.wasm"), bytes);
  }
}

async function assertAuthorityUnavailable(directory) {
  const module = await import(
    `${pathToFileURL(path.join(directory, "v4-domain-wasm.js")).href}?case=${crypto.randomUUID()}`
  );
  assert.throws(
    () => module.v4DomainWasmInfo(),
    (error) => error?.code === "rust-wasm-authority-unavailable",
  );
}

test("tracked Rust/WASM artifact is bound to its ABI metadata", () => {
  const bytes = fs.readFileSync(artifactPath);
  assert.equal(sha256(bytes), V4_DOMAIN_WASM_SHA256);
  assert.deepEqual(v4DomainWasmInfo(), {
    abiVersion: V4_DOMAIN_WASM_ABI_VERSION,
    requestContract: V4_DOMAIN_WASM_REQUEST_CONTRACT,
    responseContract: V4_DOMAIN_WASM_RESPONSE_CONTRACT,
  });
});

test("a clean Node process loads the committed artifact without Rust", () => {
  const result = spawnSyncCommand(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { v4DomainWasmInfo } from "./packages/core/v4-domain-wasm.js"; process.stdout.write(JSON.stringify(v4DomainWasmInfo()));',
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), v4DomainWasmInfo());
});

test("every production Action carries the exact core artifact", () => {
  const expected = fs.readFileSync(artifactPath);
  for (const relative of actionArtifacts) {
    assert.ok(
      fs.readFileSync(path.join(root, relative)).equals(expected),
      relative,
    );
  }
});

test("missing and tampered authority artifacts fail closed", async (context) => {
  for (const scenario of ["missing", "tampered"]) {
    await context.test(scenario, async () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), `buildchain-wasm-${scenario}-`),
      );
      try {
        copyAuthority(directory, {
          omit: scenario === "missing",
          tamper: scenario === "tampered",
        });
        await assertAuthorityUnavailable(directory);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
