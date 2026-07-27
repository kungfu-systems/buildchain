import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KFD_PRODUCT_GATE_CONTRACT,
  KFD_PRODUCT_GATE_INPUT_CONTRACT,
  createKfdSupportProjection,
  evaluateKfdProductGate,
  kfdProductGateDigest,
  validateKfdProductGateResult,
  validateKfdSupportProjection,
  verifyKfdRecord,
} from "../packages/core/kfd-product-gates.js";
import {
  collectGitHubReleasePassport,
  verifyReleasePassport,
} from "../packages/core/release-passport.js";

const require = createRequire(import.meta.url);
const kfdRoot = path.dirname(require.resolve("@kungfu-tech/kfd/package.json"));
const standardsPath = require.resolve("@kungfu-tech/kfd/standards.json");
const standards = JSON.parse(fs.readFileSync(standardsPath, "utf8"));
const sourceSha = "a".repeat(40);
const checkedAt = "2026-07-26T12:00:00.000Z";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-kfd-product-gate-"));
}

function writeJson(cwd, relativePath, value) {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return {
    path: relativePath,
    sha256: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`,
  };
}

function copyPackageJson(cwd, packageRelativePath, outputRelativePath, transform = (value) => value) {
  const value = JSON.parse(fs.readFileSync(path.join(kfdRoot, packageRelativePath), "utf8"));
  return writeJson(cwd, outputRelativePath, transform(value));
}

function evidence(cwd, id, kind) {
  return {
    id,
    kind,
    ...writeJson(cwd, `evidence/${id}.json`, { id, kind, status: "passed" }),
  };
}

function gateInput(standard, records, gateEvidence) {
  return {
    schemaVersion: 1,
    contract: KFD_PRODUCT_GATE_INPUT_CONTRACT,
    standard,
    standardRevision: standards.standards[standard].revision,
    source: { repository: "kungfu-systems/kungfu", sha: sourceSha },
    evidenceCut: {
      generatedAt: "2026-07-26T11:00:00.000Z",
      expiresAt: "2026-07-27T11:00:00.000Z",
    },
    records,
    evidence: gateEvidence,
    responsibility: {
      owner: "kungfu-systems/kungfu",
      evidenceOwner: "Kungfu maintainers",
      proofOwner: "Buildchain",
    },
    nonClaims: ["A passed gate is not KFD certification or an automatic shipped-support claim."],
  };
}

function kfd4Records(cwd) {
  const perspective = {
    schemaVersion: 1,
    contract: "kfd-4-observer-perspective",
    standard: "kfd-4",
    id: "release-maintainer-view",
    observer: { id: "release-maintainer", kind: "human" },
    acceptedFacts: [{ sourceId: "release-source", sourceKind: "repository" }],
    projectionPolicy: {
      policyVersion: "1",
      causalDominance: true,
      tieBreaker: "source-coordinate",
    },
    verification: { result: "pass" },
  };
  const replay = {
    schemaVersion: 1,
    contract: "kfd-4-perspective-replay",
    standard: "kfd-4",
    replayId: "release-product-contrast",
    mode: "contrastive",
    sourceViews: [
      {
        id: "maintainer",
        kind: "observer-view",
        coordinate: "view://maintainer",
        observer: "release-maintainer",
        perspective: "release-integrity",
        acceptedFactCut: "git://source",
        naturalObjects: ["release"],
        consequences: ["published artifact"],
        knownGaps: [],
      },
      {
        id: "consumer",
        kind: "observer-view",
        coordinate: "view://consumer",
        observer: "release-consumer",
        perspective: "artifact-consumption",
        acceptedFactCut: "artifact://release",
        naturalObjects: ["package"],
        consequences: ["installed product"],
        knownGaps: ["local environment"],
      },
    ],
    replayObserver: {
      id: "buildchain",
      kind: "service",
      purpose: "retain product and consumer fact boundaries",
    },
    reconstruction: {
      policyVersion: "1",
      sharedContext: "same source-bound release",
      preservedElements: ["observer", "accepted-fact-cut", "evidence-boundary"],
      declaredLoss: ["local runtime state"],
      degradedState: "none",
    },
    contrast: {
      dimensions: ["evidence-boundary"],
      mismatches: [{
        sourceViewIds: ["maintainer", "consumer"],
        observation: "source and artifact evidence have different custody",
        primitiveSignal: "inconclusive",
      }],
    },
    verification: { result: "pass", evidence: ["evidence/projection.json"] },
  };
  return [
    { role: "observer-perspective", ...writeJson(cwd, "records/kfd-4-perspective.json", perspective) },
    { role: "perspective-replay", ...writeJson(cwd, "records/kfd-4-replay.json", replay) },
  ];
}

function kfd5Records(cwd) {
  return [{
    role: "primitive-discovery",
    ...copyPackageJson(
      cwd,
      "cases/live/software-work-perspective-settlement/cuts/0001-assignment.json",
      "records/kfd-5-primitive-discovery.json",
    ),
  }];
}

function kfd7Records(cwd) {
  return [{
    role: "domain-profile",
    ...copyPackageJson(
      cwd,
      "verifier/fixtures/kfd-7/valid-domain-profile.json",
      "records/kfd-7-domain-profile.json",
      (profile) => ({
        ...profile,
        evidenceObligations: profile.evidenceObligations.map((entry) => ({
          ...entry,
          status: "passed",
          artifactRefs: ["qualification-proof"],
          residualRisk: "Bound to the retained product qualification cut.",
        })),
        activation: {
          decision: "activate",
          evidenceCut: "sha256:qualified-product-cut",
          independentReview: "review://independent-release-review",
          productWitnesses: ["qualification-proof"],
          residualRisk: "Independent transfer remains outside this product release.",
        },
        domainProfile: {
          ...profile.domainProfile,
          product: "Kungfu",
          implementation: `git+https://github.com/kungfu-systems/kungfu@${sourceSha}`,
          qualificationStatus: "qualified",
        },
      }),
    ),
  }];
}

async function passingGate(cwd, standard) {
  const records = standard === "kfd-4"
    ? kfd4Records(cwd)
    : standard === "kfd-5"
      ? kfd5Records(cwd)
      : kfd7Records(cwd);
  const gateEvidence = standard === "kfd-4"
    ? [evidence(cwd, "projection-fsck", "projection-fsck"), evidence(cwd, "negative", "negative-fixture")]
    : standard === "kfd-5"
      ? [evidence(cwd, "negative", "negative-fixture")]
      : [
          evidence(cwd, "qualification-proof", "qualification-proof"),
          evidence(cwd, "independent-review", "independent-review"),
          evidence(cwd, "negative", "negative-fixture"),
        ];
  return evaluateKfdProductGate({
    cwd,
    input: gateInput(standard, records, gateEvidence),
    expectedSourceSha: sourceSha,
    checkedAt,
  });
}

function supportMatrix(gates) {
  const byStandard = new Map(gates.map((gate) => [gate.standard, gate]));
  const standardsSha256 =
    `sha256:${crypto.createHash("sha256").update(fs.readFileSync(standardsPath)).digest("hex")}`;
  return {
    schemaVersion: 1,
    contract: "kungfu-kfd-support-matrix",
    authority: { path: ".buildchain/kfd/support-matrix.json" },
    upstream: {
      package: "@kungfu-tech/kfd",
      version: require("@kungfu-tech/kfd/package.json").version,
      standardsSha256,
    },
    rows: Array.from({ length: 13 }, (_, index) => {
      const number = index + 1;
      const id = `KFD-${number}`;
      const key = `kfd-${number}`;
      const gate = byStandard.get(key);
      const supportStatus = number === 4 || number === 5
        ? "candidate"
        : number === 6
          ? "unsupported"
          : number >= 8
            ? "draft-adopter-evidence"
            : number === 7
              ? "source-supported-release-blocked"
              : "source-supported";
      return {
        id,
        key,
        title: standards.standards[key].title,
        supportStatus,
        normative: {
          status: standards.standards[key].status,
          revision: standards.standards[key].revision,
        },
        implementation: { status: gate?.status === "passed" ? "implemented" : "not-evaluated" },
        verification: { status: gate?.status === "passed" ? "passed" : "not-evaluated" },
        buildchain: {
          protocol: gate ? `${KFD_PRODUCT_GATE_CONTRACT}/v1` : "none",
          gateStatus: gate?.status || "not-applicable",
        },
        releaseQualification: { shippedSupport: false },
        claimClass: "bounded-product-evidence",
        knownLimitations: [],
        owner: "kungfu-systems/kungfu",
        nextGate: "product-owned release decision",
      };
    }),
  };
}

test("KFD-4/5/7 product gates bind real KFD records and retained evidence", async () => {
  for (const standard of ["kfd-4", "kfd-5", "kfd-7"]) {
    const cwd = tempDir();
    const gate = await passingGate(cwd, standard);
    assert.equal(gate.status, "passed", JSON.stringify(gate.issues));
    assert.equal(gate.qualifying, false);
    assert.equal(gate.selfCertified, false);
    assert.equal(validateKfdProductGateResult(gate, { expectedSourceSha: sourceSha, checkedAt }).valid, true);
    for (const record of gate.records) {
      assert.equal(record.verifier.valid, true);
    }
  }
});

test("product gates fail closed on evidence drift and stale cuts", async () => {
  const cwd = tempDir();
  const records = kfd4Records(cwd);
  const gateEvidence = [
    evidence(cwd, "projection-fsck", "projection-fsck"),
    evidence(cwd, "negative", "negative-fixture"),
  ];
  fs.appendFileSync(path.join(cwd, records[0].path), "\n");
  const gate = await evaluateKfdProductGate({
    cwd,
    input: gateInput("kfd-4", records, gateEvidence),
    expectedSourceSha: sourceSha,
    checkedAt: "2026-07-28T12:00:00.000Z",
  });
  assert.equal(gate.status, "failed");
  assert.ok(gate.issues.some((entry) => entry.code === "evidence-drift"));
  assert.ok(gate.issues.some((entry) => entry.code === "stale-evidence"));
});

test("support projection preserves candidate and unsupported barriers", async () => {
  const gates = [];
  for (const standard of ["kfd-4", "kfd-5", "kfd-7"]) {
    gates.push(await passingGate(tempDir(), standard));
  }
  const projection = createKfdSupportProjection({
    matrix: supportMatrix(gates),
    gateResults: gates,
    expectedSourceSha: sourceSha,
    checkedAt,
  });
  assert.equal(projection.status, "passed", JSON.stringify(projection.issues));
  assert.equal(projection.rows.find((row) => row.id === "KFD-4").supportStatus, "candidate");
  assert.equal(projection.rows.find((row) => row.id === "KFD-6").supportStatus, "unsupported");
  assert.equal(projection.rows.find((row) => row.id === "KFD-8").supportStatus, "draft-adopter-evidence");
  assert.equal(validateKfdSupportProjection(projection, { expectedSourceSha: sourceSha, checkedAt }).valid, true);

  const widened = structuredClone(projection);
  widened.rows.find((row) => row.id === "KFD-4").releaseQualification.shippedSupport = true;
  delete widened.projectionRoot;
  widened.projectionRoot = kfdProductGateDigest(widened);
  assert.equal(validateKfdSupportProjection(widened, { expectedSourceSha: sourceSha, checkedAt }).valid, false);
});

test("KFD package verifier rejects structurally invalid records independently of product gates", async () => {
  const report = await verifyKfdRecord({
    schemaVersion: 1,
    contract: "kfd-4-observer-perspective",
    standard: "kfd-4",
  });
  assert.equal(report.valid, false);
});

test("release passport binds the exact support projection and detects sibling tampering", async () => {
  const cwd = tempDir();
  const gates = [];
  for (const standard of ["kfd-4", "kfd-5", "kfd-7"]) {
    gates.push(await passingGate(cwd, standard));
  }
  const matrixPath = writeJson(cwd, "support-matrix.json", supportMatrix(gates)).path;
  const gatePaths = gates.map((gate, index) =>
    writeJson(cwd, `gate-${index + 1}.json`, gate).path);
  fs.mkdirSync(path.join(cwd, "assets"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "assets/kungfu.tar.gz"), "product artifact\n");
  const output = collectGitHubReleasePassport({
    cwd,
    repository: "kungfu-systems/kungfu",
    tag: "v3.0.0-alpha.1",
    sourceSha,
    outputDir: "release-passport",
    assetsDir: "assets",
    kfdSupportMatrixJson: matrixPath,
    kfdProductGateJsons: gatePaths,
    checkedAt,
  });
  assert.equal(output.passport.generatedAt, checkedAt);
  assert.equal(output.passport.kfdSupport.status, "passed");
  assert.deepEqual(
    output.passport.kfdSupport,
    JSON.parse(fs.readFileSync(path.join(cwd, "release-passport/kfd-support.json"), "utf8")),
  );
  assert.equal(output.checkReport.ok, true, JSON.stringify(output.checkReport.issues));

  const passportPath = path.join(cwd, "release-passport/buildchain.release.json");
  const verification = await verifyReleasePassport({ passportLocation: passportPath, checkedAt });
  assert.equal(verification.ok, true, JSON.stringify(verification.issues));
  const siblingPath = path.join(cwd, "release-passport/kfd-support.json");
  const sibling = JSON.parse(fs.readFileSync(siblingPath, "utf8"));
  sibling.rows.find((row) => row.id === "KFD-4").supportStatus = "source-supported";
  fs.writeFileSync(siblingPath, `${JSON.stringify(sibling, null, 2)}\n`);
  const tampered = await verifyReleasePassport({ passportLocation: passportPath, checkedAt });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.issues.some((entry) => entry.code === "kfdSupport.evidence"));
});
