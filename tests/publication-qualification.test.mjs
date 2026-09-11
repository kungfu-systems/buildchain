import { fakeGitHub } from "./helpers/github-publication-provider.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
  assertNoExecutionFields,
  assertDeclarativePromotionInputs,
  createDomainPublicationQualificationReceipt,
  validatePublicationQualificationReceipt,
} from "../packages/core/publication/publication-qualification.js";
import { createDeclarativeGitHubReleasePlan } from "../packages/core/release/github-release.js";
import { publishGitHubReleaseEvidence } from "../packages/core/release/github-release.js";

const root = (character) => `sha256:${character.repeat(64)}`;
const base = () => ({
  repository: "kungfu-systems/buildchain",
  candidateRoot: root("1"),
  sourceSha: "2".repeat(40),
  sourceRoot: root("3"),
  policyDigest: root("4"),
  artifacts: [
    {
      role: "installable-product",
      platform: "linux-x64",
      artifactRoot: root("5"),
      manifestRoot: root("6"),
    },
  ],
  issuedAt: "2026-08-26T00:00:00.000Z",
  expiresAt: "2026-08-27T00:00:00.000Z",
});

function code(expected, callback) {
  assert.throws(callback, (error) => error.code === expected);
}

test("valid qualification binds candidate source artifacts policy and freshness", () => {
  const receipt = createDomainPublicationQualificationReceipt(base());
  assert.equal(
    validatePublicationQualificationReceipt(receipt, {
      candidateRoot: root("1"),
      sourceRoot: root("3"),
      artifactRoot: receipt.artifactRoot,
      policyDigest: root("4"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }).ok,
    true,
  );
});

test("missing, tampered, stale, candidate mismatch, and policy mismatch fail closed", () => {
  const receipt = createDomainPublicationQualificationReceipt(base());
  code("qualification-missing", () =>
    validatePublicationQualificationReceipt(),
  );
  code("qualification-tampered", () =>
    validatePublicationQualificationReceipt({
      ...receipt,
      sourceSha: "9".repeat(40),
    }),
  );
  code("qualification-stale", () =>
    validatePublicationQualificationReceipt(receipt, {
      evaluatedAt: "2026-08-27T00:00:00.000Z",
    }),
  );
  code("candidate-mismatch", () =>
    validatePublicationQualificationReceipt(receipt, {
      candidateRoot: root("8"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }),
  );
  code("source-mismatch", () =>
    validatePublicationQualificationReceipt(receipt, {
      sourceRoot: root("8"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }),
  );
  code("artifact-mismatch", () =>
    validatePublicationQualificationReceipt(receipt, {
      artifactRoot: root("8"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }),
  );
  code("policy-mismatch", () =>
    validatePublicationQualificationReceipt(receipt, {
      policyDigest: root("8"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }),
  );
});

test("execution-shaped fields and legacy command inputs are rejected at admission", () => {
  code("execution-field-forbidden", () =>
    assertNoExecutionFields({ nested: { run: "echo bypass" } }),
  );
  code("legacy-command-input-forbidden", () =>
    assertDeclarativePromotionInputs({
      "publication-gate-command": "node gate.js",
    }),
  );
  assert.doesNotThrow(() =>
    assertDeclarativePromotionInputs({ "dry-run": true }),
  );
});

test("Provider Plane and terminal receipt remain in separate permission boundaries", () => {
  const workflow = YAML.parse(
    fs.readFileSync(
      new URL("../.github/workflows/.release-promote.yml", import.meta.url),
      "utf8",
    ),
  );
  const action = (name) =>
    YAML.parse(
      fs.readFileSync(
        new URL(`../actions/release/${name}/action.yml`, import.meta.url),
        "utf8",
      ),
    );
  const apply = action("promotion/apply");
  const settle = action("promotion/settle");
  assert.deepEqual(workflow.jobs.apply.needs, ["qualify", "execution-runtime"]);
  assert.deepEqual(workflow.jobs.settle.needs, ["qualify", "apply", "execution-runtime"]);
  assert.deepEqual(workflow.jobs.settle.permissions, {
    actions: "read",
    contents: "read",
  });
  assert.equal(
    apply.runs.steps.filter(
      (step) =>
        step.uses === "./.buildchain/runtime/actions/release/promotion/candidate",
    ).length,
    2,
  );
  for (const name of [
    "release-invocation-root",
    "release-transaction-root",
    "release-receipt-root",
  ])
    assert.ok(apply.outputs[name]);
  assert.ok(
    apply.runs.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    ),
  );
  assert.match(
    settle.runs.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    ).with.path,
    /release-receipt\.json/,
  );
});

test("qualified v4 release materializes the four built-in provider capabilities", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-tail-"));
  try {
    const asset = path.join(directory, "buildchain.release.json");
    fs.writeFileSync(asset, "{}\n");
    const legacy = createDeclarativeGitHubReleasePlan({
      repository: "kungfu-systems/buildchain",
      sourceSha: "a".repeat(40),
      version: "3.0.0",
      tag: "v3.0.0",
      channel: "stable",
      assetPaths: [asset],
    });
    assert.deepEqual(
      legacy.plan.effects.map(({ capabilityId }) => capabilityId),
      ["artifact.publish"],
    );
    const result = createDeclarativeGitHubReleasePlan({
      repository: "kungfu-systems/buildchain",
      sourceSha: "a".repeat(40),
      version: "4.0.0-alpha.1",
      tag: "v4.0.0-alpha.1",
      channel: "alpha",
      assetPaths: [asset],
      qualificationRoot: root("b"),
    });
    assert.deepEqual(
      result.plan.effects.map(({ capabilityId }) => capabilityId),
      [
        "artifact.publish",
        "signed-channel.commit",
        "release.activate",
        "released-evidence.synthesize",
      ],
    );
    assert.equal(
      new Set(result.plan.effects.map(({ transactionRoot }) => transactionRoot))
        .size,
      1,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("v4 provider checkpoint resumes only the incomplete tail after injected failure", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-resume-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const passportDir = path.join(directory, "passport");
  fs.mkdirSync(passportDir);
  const evidence = path.join(directory, "publication-evidence.json");
  const passport = path.join(passportDir, "buildchain.release.json");
  fs.writeFileSync(evidence, '{"evidence":true}\n');
  fs.writeFileSync(passport, '{"passport":true}\n');
  const github = fakeGitHub();
  const options = {
    octokit: github.octokit,
    repository: "kungfu-systems/buildchain",
    sourceSha: "a".repeat(40),
    version: "4.0.0-alpha.1",
    tag: "v4.0.0-alpha.1",
    channel: "alpha",
    publishEvidencePath: evidence,
    releasePassportPath: passport,
    releasePassportOutputDir: passportDir,
    statePath: path.join(directory, "state.json"),
    qualificationRoot: root("b"),
  };
  await assert.rejects(
    publishGitHubReleaseEvidence({
      ...options,
      failureAfterCapability: "artifact.publish",
    }),
    /injected provider failure/u,
  );
  const interrupted = JSON.parse(fs.readFileSync(options.statePath, "utf8"));
  assert.deepEqual(
    interrupted.receipts.map(({ capabilityId }) => capabilityId),
    ["artifact.publish"],
  );
  const resumed = await publishGitHubReleaseEvidence(options);
  assert.equal(resumed.transaction.state, "complete");
  assert.deepEqual(
    resumed.transaction.receipts.map(({ capabilityId }) => capabilityId),
    [
      "artifact.publish",
      "signed-channel.commit",
      "release.activate",
      "released-evidence.synthesize",
    ],
  );
  assert.equal(github.state.mutations, 3);
});
