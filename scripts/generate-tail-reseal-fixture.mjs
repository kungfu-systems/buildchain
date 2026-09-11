#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  scanFloatingConsumerPolicy,
  consumerPolicyScannerRoot,
} from "../packages/core/consumer/floating-consumer-policy.js";
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(
  repositoryRoot,
  "contracts/fixtures/v4-tail-reseal-v1/valid.json",
);
export function tailResealFixturePolicyReceipt(fixture, policy) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-tail-policy-"),
  );
  try {
    fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".github/workflows/build.yml"),
      "jobs:\n  build:\n    uses: kungfu-systems/buildchain/.github/workflows/public-build-stage-capsule-canary.yml@v4-alpha\n",
    );
    fs.mkdirSync(path.join(root, ".buildchain"), { recursive: true });
    for (const [file, ref, resolvedSha] of [
      ["contract-lock.json", "v4", "e".repeat(40)],
      ["alpha-contract-lock.json", "v4-alpha", fixture.runtime.sha],
    ]) {
      const lock = {
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
      fs.writeFileSync(
        path.join(root, ".buildchain", file),
        `${JSON.stringify(lock)}\n`,
      );
    }
    const result = scanFloatingConsumerPolicy({
      root,
      repository: fixture.repository,
      sourceSha: fixture.source.sha,
      invokedWorkflow: "public-build-stage-capsule-canary.yml",
      expectedInvocationChannel: "alpha",
      resolvedRuntimeSha: fixture.runtime.sha,
      policy,
      scannerRoot: consumerPolicyScannerRoot(),
    });
    if (!result.ok)
      throw Error(
        `Synthetic fixture admission failed: ${result.failures.map((x) => x.code).join(", ")}`,
      );
    return { receipt: result.receipt, receiptRoot: result.receiptRoot };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
export function generateTailResealFixture({ check = false } = {}) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, "architecture/floating-consumer-policy.json"),
      "utf8",
    ),
  );
  const { receiptRoot } = tailResealFixturePolicyReceipt(fixture, policy);
  const previousRoot = fixture.runtime.consumerPolicyReceiptRoot;
  if (check && receiptRoot !== previousRoot)
    throw Error(
      "Current tail-reseal synthetic policy receipt fixture is stale",
    );
  if (!check && receiptRoot !== previousRoot) {
    fixture.runtime.consumerPolicyReceiptRoot = receiptRoot;
    fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  return {
    fixture: "contracts/fixtures/v4-tail-reseal-v1/valid.json",
    previousRoot,
    receiptRoot,
    check,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        generateTailResealFixture({ check: process.argv.includes("--check") }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
