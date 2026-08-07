import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPublicationRehearsalCapsule,
  executePublicationRehearsal,
  publicationRehearsalBindingRoot,
  publicationRehearsalDiagnostic,
  verifyPublicationRehearsalCapsule,
} from "../packages/core/publication-rehearsal-runtime.js";

function root(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function fixture(name = "fixture") {
  const capsuleRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `buildchain-rehearsal-${name}-`),
  );
  const declaration = JSON.parse(
    fs.readFileSync(
      "contracts/fixtures/release-tail-capabilities-v1/kungfu-alpha.json",
      "utf8",
    ),
  );
  const sources = {
    "artifacts/product.bin": Buffer.from("synthetic-product\n"),
    "evidence/release-passport.json": Buffer.from(
      `${JSON.stringify({ schema: "synthetic.release-passport/v1", subject: "fixture" })}\n`,
    ),
    "documents/channel.json": Buffer.from(
      `${JSON.stringify({ schema: "synthetic.channel/v1", version: "4.0.0-alpha.1" })}\n`,
    ),
    "documents/activation.json": Buffer.from(
      `${JSON.stringify({ schema: "synthetic.activation/v1", version: "4.0.0-alpha.1" })}\n`,
    ),
    "evidence/activation.json": Buffer.from(
      `${JSON.stringify({ schema: "synthetic.activation-receipt/v1", status: "fixture" })}\n`,
    ),
  };
  const roles = {
    "artifacts/product.bin": "installable-product",
    "evidence/release-passport.json": "release-passport",
    "documents/channel.json": "signed-channel-document",
    "documents/activation.json": "activation-document",
    "evidence/activation.json": "activation-receipt-set",
  };
  const files = Object.entries(sources)
    .map(([relativePath, contents]) => {
      const filePath = path.join(capsuleRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
      return {
        role: roles[relativePath],
        path: relativePath,
        size: contents.length,
        root: root(contents),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const passport = files.find((entry) => entry.role === "release-passport");
  const providerBindings = {
    schema: "kungfu.buildchain.release-tail.provider-bindings/v1",
    artifacts: {
      "installable-product": {
        path: "artifacts/product.bin",
        name: "product.bin",
      },
      "release-passport": {
        path: "evidence/release-passport.json",
        name: "buildchain.release.json",
      },
    },
    documents: {
      "signed-channel.commit": {
        path: "documents/channel.json",
        method: "PUT",
      },
      "release.activate": {
        path: "documents/activation.json",
        method: "POST",
      },
    },
    evidence: {
      inputs: ["evidence/activation.json"],
      output: "output/released-evidence.json",
    },
  };
  const capsule = createPublicationRehearsalCapsule({
    declaration,
    policyRoots: [root("fixture-policy")],
    passport: { path: passport.path, root: passport.root },
    files,
    providerBindings,
  });
  return { capsuleRoot, capsule, declaration, files, providerBindings };
}

function replayObservations(capsule, { transientFirst = false } = {}) {
  return capsule.transaction.operations.map((operation, index) => ({
    operationId: operation.operationId,
    readbacks: [
      ...(transientFirst && index === 0
        ? [
            {
              outcome: "transient",
              subjectRoot: "",
              targetRoot: "",
              evidenceRoots: [],
              providerCode: "recorded-network-transient",
            },
          ]
        : []),
      {
        outcome: "absent",
        subjectRoot: "",
        targetRoot: "",
        evidenceRoots: [],
        providerCode: "recorded-absent",
      },
      {
        outcome: "observed",
        subjectRoot: operation.effect.subjectRoot,
        targetRoot: operation.effect.targetRoot,
        evidenceRoots: [operation.effect.targetRoot],
        providerCode: "recorded-observed",
      },
    ],
    apply: {
      outcome: "applied",
      code: "recorded-applied",
      classification: "none",
    },
  }));
}

test("local simulation executes the shared deterministic release-tail core", async () => {
  const input = fixture("positive");
  const result = await executePublicationRehearsal({
    capsule: input.capsule,
    capsuleRoot: input.capsuleRoot,
    mode: "simulate",
    environment: {},
  });
  assert.equal(result.transaction.state, "complete");
  assert.equal(result.transaction.receipts.length, 4);
  assert.equal(result.evidence.truth, "simulation-only");
  assert.equal(result.evidence.externalPublicationClaimed, false);
  assert.equal(
    result.evidence.bindingRoot,
    publicationRehearsalBindingRoot(input.capsule),
  );
  assert.match(result.evidence.evidenceRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("public CLI writes the same rooted transaction and rehearsal evidence", () => {
  const input = fixture("cli");
  const capsulePath = path.join(input.capsuleRoot, "rehearsal-capsule.json");
  const statePath = path.join(input.capsuleRoot, "rehearsal-state.json");
  const evidencePath = path.join(input.capsuleRoot, "rehearsal-evidence.json");
  fs.writeFileSync(capsulePath, `${JSON.stringify(input.capsule, null, 2)}\n`);
  const result = spawnSync(
    process.execPath,
    [
      "bin/buildchain.mjs",
      "release-tail",
      "rehearse",
      "--capsule",
      capsulePath,
      "--capsule-root",
      input.capsuleRoot,
      "--mode",
      "simulate",
      "--state",
      statePath,
      "--evidence",
      evidencePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(state.state, "complete");
  assert.equal(evidence.transactionRoot, state.transactionRoot);
  assert.equal(
    evidence.bindingRoot,
    publicationRehearsalBindingRoot(input.capsule),
  );
  const implicitPath = spawnSync(
    process.execPath,
    [
      "bin/buildchain.mjs",
      "release-tail",
      "rehearse",
      "--capsule",
      "rehearsal-capsule.json",
      "--capsule-root",
      input.capsuleRoot,
      "--state",
      statePath,
      "--evidence",
      evidencePath,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(implicitPath.status, 0);
  assert.match(
    implicitPath.stderr,
    /--capsule must be an explicit absolute path/u,
  );
});

test("capsule file tampering fails closed with a stable rooted diagnostic", async () => {
  const input = fixture("tamper");
  fs.appendFileSync(
    path.join(input.capsuleRoot, "artifacts/product.bin"),
    "tampered\n",
  );
  let error;
  await assert.rejects(
    () =>
      executePublicationRehearsal({
        capsule: input.capsule,
        capsuleRoot: input.capsuleRoot,
        environment: {},
      }),
    (caught) => {
      error = caught;
      return caught.rehearsalCode === "capsule-file-tampered";
    },
  );
  const diagnostic = publicationRehearsalDiagnostic(error, {
    capsule: input.capsule,
  });
  assert.equal(
    diagnostic.bindingRoot,
    publicationRehearsalBindingRoot(input.capsule),
  );
  assert.match(diagnostic.diagnosticRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("undeclared environment and platform assumptions are rejected", async () => {
  const input = fixture("environment");
  await assert.rejects(
    () =>
      executePublicationRehearsal({
        capsule: input.capsule,
        capsuleRoot: input.capsuleRoot,
        environment: { GITHUB_SHA: "ambient" },
      }),
    (error) => error.rehearsalCode === "undeclared-environment",
  );
  const platformCapsule = structuredClone(input.capsule);
  platformCapsule.runtime.platform = "linux";
  platformCapsule.root = root("intentionally-invalid-platform-capsule");
  assert.throws(
    () =>
      verifyPublicationRehearsalCapsule({
        capsule: platformCapsule,
        capsuleRoot: input.capsuleRoot,
      }),
    (error) => error.rehearsalCode === "platform-assumption-forbidden",
  );
  assert.throws(
    () =>
      verifyPublicationRehearsalCapsule({
        capsule: input.capsule,
        capsuleRoot: ".buildchain/publication/candidate",
      }),
    (error) => error.rehearsalCode === "implicit-workspace-forbidden",
  );

  const effectCapsule = structuredClone(input.capsule);
  effectCapsule.runtime.externalEffects.push({
    capabilityId: "registry.publish",
    adapter: "ambient-shell",
    kind: "undeclared",
  });
  assert.throws(
    () =>
      verifyPublicationRehearsalCapsule({
        capsule: effectCapsule,
        capsuleRoot: input.capsuleRoot,
      }),
    (error) => error.rehearsalCode === "undeclared-provider-effect",
  );

  const pathCapsule = structuredClone(input.capsule);
  pathCapsule.files[0].path = "../outside";
  assert.throws(
    () =>
      verifyPublicationRehearsalCapsule({
        capsule: pathCapsule,
        capsuleRoot: input.capsuleRoot,
      }),
    (error) => error.rehearsalCode === "capsule-path-ambiguous",
  );
});

test("moving identical capsule bytes does not change binding or evidence roots", async () => {
  const input = fixture("layout-a");
  const relocated = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-rehearsal-layout-b-"),
  );
  fs.cpSync(input.capsuleRoot, relocated, { recursive: true });
  const first = await executePublicationRehearsal({
    capsule: input.capsule,
    capsuleRoot: input.capsuleRoot,
    environment: {},
  });
  const second = await executePublicationRehearsal({
    capsule: input.capsule,
    capsuleRoot: relocated,
    environment: {},
  });
  assert.equal(second.evidence.bindingRoot, first.evidence.bindingRoot);
  assert.equal(second.evidence.evidenceRoot, first.evidence.evidenceRoot);
  assert.deepEqual(second.transaction, first.transaction);
});

test("recorded replay preserves bounded retry and deterministic roots", async () => {
  const input = fixture("replay");
  const replayCapsule = createPublicationRehearsalCapsule({
    declaration: input.capsule.declaration,
    policyRoots: input.capsule.policyRoots,
    passport: input.capsule.passport,
    transaction: input.capsule.transaction,
    files: input.capsule.files,
    providerBindings: input.capsule.providerBindings,
    providerObservations: replayObservations(input.capsule, {
      transientFirst: true,
    }),
    runtime: input.capsule.runtime,
  });
  const result = await executePublicationRehearsal({
    capsule: replayCapsule,
    capsuleRoot: input.capsuleRoot,
    mode: "replay",
    environment: {},
  });
  assert.equal(result.transaction.state, "complete");
  assert.equal(result.transaction.operations[0].readbackAttempts, 3);
  assert.equal(result.transaction.operations[0].effectAttempts, 1);

  const repeated = await executePublicationRehearsal({
    capsule: replayCapsule,
    capsuleRoot: input.capsuleRoot,
    mode: "replay",
    environment: {},
    transaction: result.transaction,
  });
  assert.deepEqual(repeated.transaction, result.transaction);
  assert.equal(repeated.evidence.transcript.length, 0);
});

test("provider mode records every shared-core readback and effect without changing authority", async () => {
  const input = fixture("provider-recording");
  const state = new Map();
  const adapters = Object.fromEntries(
    input.capsule.declaration.capabilities.map((capability) => [
      capability.adapter,
      {
        async readback(effect) {
          return state.has(effect.operationId)
            ? {
                outcome: "observed",
                subjectRoot: effect.subjectRoot,
                targetRoot: effect.targetRoot,
                evidenceRoots: [effect.targetRoot],
                providerCode: "fixture-provider-observed",
              }
            : {
                outcome: "absent",
                providerCode: "fixture-provider-absent",
              };
        },
        async apply(effect) {
          state.set(effect.operationId, effect.targetRoot);
        },
      },
    ]),
  );
  const result = await executePublicationRehearsal({
    capsule: input.capsule,
    capsuleRoot: input.capsuleRoot,
    mode: "provider",
    environment: {},
    adapters,
  });
  assert.equal(result.transaction.state, "complete");
  assert.equal(result.evidence.truth, "provider-observed");
  assert.equal(result.evidence.externalPublicationClaimed, false);
  assert.deepEqual(
    result.evidence.transcript.map((entry) => entry.method),
    input.capsule.transaction.operations.flatMap(() => [
      "readback",
      "apply",
      "readback",
    ]),
  );
});

test("local and hosted wrappers retain the same deterministic failure class and binding root", async () => {
  const input = fixture("parity");
  const diagnostics = [];
  for (const mode of ["simulate", "provider"]) {
    let error;
    await assert.rejects(
      () =>
        executePublicationRehearsal({
          capsule: input.capsule,
          capsuleRoot: input.capsuleRoot,
          mode,
          environment: { GITHUB_WORKSPACE: "/implicit" },
          adapters: {},
        }),
      (caught) => {
        error = caught;
        return true;
      },
    );
    diagnostics.push(
      publicationRehearsalDiagnostic(error, { capsule: input.capsule }),
    );
  }
  assert.deepEqual(
    diagnostics.map((entry) => [
      entry.errorClass,
      entry.code,
      entry.bindingRoot,
    ]),
    [
      [
        "input",
        "undeclared-environment",
        publicationRehearsalBindingRoot(input.capsule),
      ],
      [
        "input",
        "undeclared-environment",
        publicationRehearsalBindingRoot(input.capsule),
      ],
    ],
  );
});

test("hosted Action is a thin adapter over the public rehearsal runtime", () => {
  const source = fs.readFileSync("actions/release-tail/index.js", "utf8");
  assert.match(source, /executePublicationRehearsal/u);
  assert.doesNotMatch(source, /executeReleaseTailTransaction/u);
  assert.doesNotMatch(source, /compileReleaseTailDeclaration/u);
  assert.match(source, /capsule-contract/u);
  assert.match(source, /capsule-root/u);
});
