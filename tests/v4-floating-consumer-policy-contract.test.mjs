import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initBuildchainRepo } from "../scripts/init-repo.mjs";
import {
  assertPromotionCertificationWiring,
  assertTrustGatedJobs,
  checkV4FloatingConsumerPolicyContract,
  workflowJobBlock,
} from "../scripts/check-v4-floating-consumer-policy-contract.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("v4 floating policy contract check accepts the repository wiring", () => {
  assert.equal(checkV4FloatingConsumerPolicyContract().ok, true);
});

test("v4 floating policy contract rejects certification without caller lock readback", () => {
  assert.throws(
    () =>
      assertPromotionCertificationWiring(
        "node .buildchain/runtime/scripts/v4-consumer-policy.mjs certify",
      ),
    /promotion certification is missing/u,
  );
});

test("v4 floating policy contract rejects an unbound certification root", () => {
  const workflow = fs
    .readFileSync(
      path.join(root, ".github/workflows/.release-candidate-promote.yml"),
      "utf8",
    )
    .replace(
      /^\s*release-passport-v4-consumer-policy-certification-root:.*$/mu,
      "",
    );
  assert.throws(
    () => assertPromotionCertificationWiring(workflow),
    /promotion certification is missing/u,
  );
});

test("v4 floating policy contract check rejects a heavy job without trust-gate", () => {
  const source = `jobs:\n  resolve-source:\n    needs:\n      - trust-gate\n  build-native:\n    needs:\n      - resolve-source\n`;
  assert.match(workflowJobBlock(source, "build-native"), /resolve-source/u);
  assert.throws(
    () => assertTrustGatedJobs(source, ["resolve-source", "build-native"]),
    /build-native is not directly gated by trust-gate/u,
  );
});

test("generated consumer workflow persists v4 and declares both contract locks", () => {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-policy-template-"),
  );
  try {
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      '{"name":"fixture","version":"1.0.0"}\n',
    );
    initBuildchainRepo({ cwd, type: "package", packageManager: "npm" });
    const workflow = fs.readFileSync(
      path.join(cwd, ".github/workflows/build.yml"),
      "utf8",
    );
    assert.match(workflow, /@v4/u);
    assert.match(workflow, /\.buildchain\/contract-lock\.json/u);
    assert.match(workflow, /\.buildchain\/alpha-contract-lock\.json/u);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
