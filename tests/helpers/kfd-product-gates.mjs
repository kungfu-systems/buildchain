import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { KFD_PRODUCT_GATE_INPUT_CONTRACT, evaluateKfdProductGate } from "../../packages/core/adoption/kfd-product-gates.js";
import { addAdopterWitness, initAdopterManifest } from "@kungfu-tech/kfd/adopter-conformance/toolchain";

const require = createRequire(import.meta.url);
const kfdRoot = path.dirname(require.resolve("@kungfu-tech/kfd/package.json"));
const standardsPath = require.resolve("@kungfu-tech/kfd/standards.json");
const standards = JSON.parse(fs.readFileSync(standardsPath, "utf8"));
const sourceSha = "a".repeat(40);
const checkedAt = "2026-07-26T12:00:00.000Z";
const kfdPackageArtifactRoot = "sha256:539d68720e26545fa42ad36fa0d716806a83f446d7b2710f0b9b410fa420c08c";
const buildchainRepository = "kungfu-systems/buildchain";
const kungfuRepository = "kungfu-systems/kungfu";

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

function gateInput(standard, records, gateEvidence, sourceRepository = buildchainRepository) {
  return {
    schemaVersion: 1,
    contract: KFD_PRODUCT_GATE_INPUT_CONTRACT,
    standard,
    standardRevision: standards.standards[standard].revision,
    source: { repository: sourceRepository, sha: sourceSha },
    evidenceCut: {
      generatedAt: "2026-07-26T11:00:00.000Z",
      expiresAt: "2026-07-27T11:00:00.000Z",
    },
    records,
    evidence: gateEvidence,
    responsibility: {
      owner: sourceRepository,
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

async function passingGate(cwd, standard, sourceRepository = buildchainRepository) {
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
    input: gateInput(standard, records, gateEvidence, sourceRepository),
    expectedSourceSha: sourceSha,
    checkedAt,
  });
}

function manifestEvidence(id, kind, root, sourceRepository = buildchainRepository) {
  return {
    kind,
    coordinate: `git+https://github.com/${sourceRepository}@${sourceSha}#${id.toLowerCase()}`,
    root,
    observedAt: checkedAt,
    kfdPackageRoot: kfdPackageArtifactRoot,
  };
}

function adopterManifest(gates, { adopterId = buildchainRepository, sourceRepository = adopterId, manifestId = "buildchain-v3-full-cut", scope = "Buildchain v3 release and protected delivery authority" } = {}) {
  const gateById = new Map(gates.map((gate) => [gate.standard.toUpperCase(), gate]));
  const manifest = initAdopterManifest({
    manifestId,
    adopterId,
    artifactKind: "git-commit",
    artifactCoordinate: `${sourceRepository}@${sourceSha}`,
    artifactRoot: `sha256:${"b".repeat(64)}`,
    scope,
    packageArtifactRoot: kfdPackageArtifactRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds: 86400,
  });
  for (const id of ["KFD-1", "KFD-2", "KFD-3", "KFD-4", "KFD-5", "KFD-7"]) {
    const row = manifest.decisions.find((entry) => entry.id === id);
    const suffix = String(row.number).padStart(2, "0");
    row.state = "candidate";
    row.usage = "used";
    row.implementationEvidence = [manifestEvidence(id, "implementation", `sha256:${suffix.repeat(32)}`, sourceRepository)];
    row.verificationEvidence = [manifestEvidence(
      id,
      "verification",
      gateById.get(id)?.gateRoot || `sha256:${String(row.number + 20).padStart(2, "0").repeat(32)}`,
      sourceRepository,
    )];
    row.gaps = ["Independent decision-specific assessment remains external."];
  }
  const kfd6 = manifest.decisions.find((entry) => entry.id === "KFD-6");
  kfd6.state = "unsupported";
  kfd6.gaps = [`${adopterId} does not claim KFD-6 support in this cut.`];
  return addAdopterWitness(manifest, {
    decisionId: "KFD-10",
    profileId: "kfd-warrant-evidence",
    witnessCoordinate: `${sourceRepository}@${sourceSha}#dev-delivery-warrant`,
    witnessRoot: `sha256:${"c".repeat(64)}`,
    packageArtifactRoot: kfdPackageArtifactRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds: 86400,
  });
}

function buildchainAdopterManifest(gates) {
  return adopterManifest(gates);
}

export { sourceSha, checkedAt, kfdPackageArtifactRoot, buildchainRepository, kungfuRepository, tempDir, writeJson, copyPackageJson, evidence, gateInput, kfd4Records, kfd5Records, kfd7Records, passingGate, adopterManifest, buildchainAdopterManifest, kfdRoot, standards };
