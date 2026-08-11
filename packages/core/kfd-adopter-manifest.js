import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

import kfdPackageJson from "@kungfu-tech/kfd/package.json" with { type: "json" };
import kfdStandards from "@kungfu-tech/kfd/standards.json" with { type: "json" };
import {
  bundleAdopterManifest,
  verifyAdopterManifestFromPackage,
} from "@kungfu-tech/kfd/adopter-conformance/toolchain";

import {
  KFD_PRODUCT_GATE_CONTRACT,
  kfdProductGateDigest,
  validateKfdProductGateResult,
} from "./kfd-product-gates.js";

export const KFD_ADOPTER_MANIFEST_GATE_CONTRACT =
  "kungfu-buildchain-kfd-adopter-manifest-gate";
export const KFD_LEGACY_SUPPORT_MATRIX_CONTRACT = "kungfu-kfd-support-matrix";

const BUILDCHAIN_ADOPTER_ID = "kungfu-systems/buildchain";
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REQUIRED_DECISIONS = Object.freeze(["KFD-1", "KFD-2", "KFD-3", "KFD-4", "KFD-5", "KFD-7"]);
const PRODUCT_GATE_STANDARDS = Object.freeze(["kfd-4", "kfd-5", "kfd-7"]);
const PRODUCT_GATE_SET = new Set(PRODUCT_GATE_STANDARDS);
const require = createRequire(import.meta.url);

function issue(code, path, message, detail = {}) {
  return { level: "error", code, path, message, ...detail };
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function standardsFileDigest() {
  const bytes = fs.readFileSync(require.resolve("@kungfu-tech/kfd/standards.json"));
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function standardMetadata(standard) {
  return kfdStandards?.standards?.[standard] || {};
}

function decisionWitnessRow(row) {
  const roots = (entries) => (entries || []).map((entry) => entry?.root || "");
  return {
    id: row.id,
    state: row.state,
    usage: row.usage,
    implementationRoots: roots(row.implementationEvidence),
    verificationRoots: roots(row.verificationEvidence),
    negativeRoots: roots(row.negativeEvidence),
    reviewRoots: roots(row.reviews),
    witnessRoots: (row.witnessBindings || []).map((entry) => entry?.witnessRoot || ""),
    releaseBindingIds: [...(row.releaseBindingIds || [])],
    claims: [...(row.claims || [])],
    gaps: [...(row.gaps || [])],
  };
}

function verifyPublishedManifest(manifest, packageOptions, issues) {
  try {
    const report = verifyAdopterManifestFromPackage(manifest, packageOptions);
    if (!report.valid) {
      issues.push(issue("adopter-manifest-invalid", "manifest", "published KFD adopter verifier rejected the manifest", {
        manifestIssues: report.issues,
      }));
      return null;
    }
    return bundleAdopterManifest(manifest, packageOptions);
  } catch (error) {
    issues.push(issue("adopter-manifest-invalid", "manifest", error.message));
    return null;
  }
}

function manifestSourceSha(manifest) {
  const match = /^kungfu-systems\/buildchain@([0-9a-f]{40})$/.exec(text(manifest?.adopter?.artifact?.coordinate));
  return match?.[1] || "";
}

function validateManifestIdentity(manifest, packageArtifactRoot, expectedSourceSha, issues) {
  if (manifest?.adopter?.id !== BUILDCHAIN_ADOPTER_ID) {
    issues.push(issue("adopter-identity", "manifest.adopter.id", `manifest adopter must be ${BUILDCHAIN_ADOPTER_ID}`));
  }
  const pinned = manifest?.kfdCut?.package;
  if (pinned?.name !== kfdPackageJson.name
    || pinned?.version !== kfdPackageJson.version
    || pinned?.artifactRoot !== packageArtifactRoot) {
    issues.push(issue("adopter-package-cut", "manifest.kfdCut.package", "manifest must bind the exact installed KFD package cut"));
  }
  const sourceSha = manifestSourceSha(manifest);
  if (manifest?.adopter?.artifact?.kind !== "git-commit" || !sourceSha
    || !ROOT_PATTERN.test(text(manifest?.adopter?.artifact?.root))) {
    issues.push(issue("adopter-source", "manifest.adopter.artifact", "Buildchain adopter authority must bind one exact git commit and artifact root"));
  } else if (expectedSourceSha && sourceSha !== expectedSourceSha) {
    issues.push(issue("adopter-source", "manifest.adopter.artifact.coordinate", "manifest source does not match the requested release source"));
  }
  return sourceSha;
}

function validateRequiredDecisions(decisions, issues) {
  for (const id of REQUIRED_DECISIONS) {
    const row = decisions.get(id);
    if (!row || !["candidate", "adopted"].includes(row.state) || row.usage === "unused") {
      issues.push(issue("adopter-required-decision", `manifest.decisions.${id}`, `${id} must remain an explicit used candidate or adopted declaration`));
    } else if ((row.implementationEvidence || []).length === 0 || (row.verificationEvidence || []).length === 0) {
      issues.push(issue("adopter-required-evidence", `manifest.decisions.${id}`, `${id} must bind implementation and verification evidence`));
    }
  }
  const kfd6 = decisions.get("KFD-6");
  if (kfd6?.state !== "unsupported" || kfd6?.usage !== "unused") {
    issues.push(issue("adopter-kfd6-barrier", "manifest.decisions.KFD-6", "KFD-6 must remain explicitly unsupported and unused"));
  }
}

function validateWarrantWitness(decisions, issues) {
  const row = decisions.get("KFD-10");
  const witnesses = (row?.witnessBindings || []).filter((entry) =>
    entry?.decisionId === "KFD-10" && entry?.profileId === "kfd-warrant-evidence");
  if (row?.state !== "draft-evidence" || row?.usage !== "evaluating" || witnesses.length !== 1) {
    issues.push(issue("adopter-kfd10-witness", "manifest.decisions.KFD-10", "KFD-10 must retain exactly one draft Warrant-evidence witness binding"));
  }
}

function collectProductGates(gateResults, decisions, verificationCut, issues) {
  const gates = new Map();
  for (const [index, gate] of gateResults.entries()) {
    const validation = validateKfdProductGateResult(gate, verificationCut);
    if (!validation.valid) {
      issues.push(issue("adopter-gate-invalid", `gateResults[${index}]`, "Buildchain product gate is invalid", {
        gateIssues: validation.issues,
      }));
    }
    if (!PRODUCT_GATE_SET.has(gate?.standard)) {
      issues.push(issue("adopter-gate-standard", `gateResults[${index}].standard`, "only the exact KFD-4/5/7 product-gate set is allowed"));
    }
    if (gates.has(gate?.standard)) {
      issues.push(issue("adopter-gate-duplicate", `gateResults[${index}].standard`, `${gate.standard} gate is duplicated`));
    }
    gates.set(gate?.standard, gate);
  }
  for (const standard of PRODUCT_GATE_STANDARDS) {
    const gate = gates.get(standard);
    const id = standard.toUpperCase();
    if (!gate) {
      issues.push(issue("adopter-gate-missing", `gateResults.${standard}`, `${id} requires its existing Buildchain product gate`));
    } else if (!(decisions.get(id)?.verificationEvidence || []).some((entry) => entry?.root === gate.gateRoot)) {
      issues.push(issue("adopter-gate-unbound", `manifest.decisions.${id}.verificationEvidence`, `${id} must bind the exact Buildchain gate root`));
    }
  }
  return gates;
}

function projectedProductGates(gates) {
  return PRODUCT_GATE_STANDARDS.map((standard) => {
    const gate = gates.get(standard);
    return gate
      ? { standard, sourceSha: gate.source.sha, gateRoot: gate.gateRoot, status: gate.status }
      : { standard, sourceSha: "", gateRoot: "", status: "missing" };
  });
}

function createGateDocument({ manifest, bundle, gates, authorityPath, packageArtifactRoot, sourceSha, checkedAt, maxAgeSeconds, issues }) {
  const gate = {
    schemaVersion: 1,
    contract: KFD_ADOPTER_MANIFEST_GATE_CONTRACT,
    checkedAt,
    authority: {
      path: authorityPath,
      contract: text(manifest?.contract),
      manifestRoot: bundle?.roots?.manifestRoot || "",
    },
    source: {
      sha: sourceSha,
      artifactRoot: text(manifest?.adopter?.artifact?.root),
    },
    verificationCut: { checkedAt, maxAgeSeconds },
    standardPackage: {
      name: kfdPackageJson.name,
      version: kfdPackageJson.version,
      artifactRoot: text(manifest?.kfdCut?.package?.artifactRoot || packageArtifactRoot),
      registryRoot: text(manifest?.kfdCut?.registry?.root),
      verifierSetRoot: text(manifest?.kfdCut?.verifierSetRoot),
    },
    decisionWitness: {
      rootAlgorithm: "sha256-buildchain-stable-json-v1",
      root: kfdProductGateDigest((manifest?.decisions || []).map(decisionWitnessRow)),
    },
    gateResults: projectedProductGates(gates),
    manifestVerificationReportRoot: bundle?.roots?.verificationReportRoot || "",
    manifestBundleRoot: bundle?.bundleRoot || "",
    status: bundle && issues.length === 0 ? "passed" : "failed",
    qualifying: false,
    selfCertified: false,
    nonClaims: [
      "The standard adopter manifest is the sole declaration authority; legacy support matrices are projections only.",
      "A passing manifest gate does not authorize release, runtime action, activation, or independent certification.",
    ],
    issues,
  };
  gate.gateRoot = kfdProductGateDigest(gate);
  return gate;
}

export function createKfdAdopterManifestGate({
  manifest,
  packageArtifactRoot = "",
  gateResults = [],
  authorityPath = ".buildchain/kfd/adopter-manifest.json",
  expectedSourceSha = "",
  checkedAt = new Date().toISOString(),
  maxAgeSeconds = 86400,
} = {}) {
  const issues = [];
  const bundle = verifyPublishedManifest(manifest, {
    packageArtifactRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds,
  }, issues);
  const decisions = new Map((manifest?.decisions || []).map((row) => [row.id, row]));
  let sourceSha = manifestSourceSha(manifest);
  if (bundle) {
    sourceSha = validateManifestIdentity(manifest, packageArtifactRoot, expectedSourceSha, issues);
    validateRequiredDecisions(decisions, issues);
    validateWarrantWitness(decisions, issues);
  }
  const gates = collectProductGates(gateResults, decisions, { expectedSourceSha: sourceSha || expectedSourceSha, checkedAt }, issues);
  return createGateDocument({ manifest, bundle, gates, authorityPath, packageArtifactRoot, sourceSha, checkedAt, maxAgeSeconds, issues });
}

function validateGateDocument(gate, issues) {
  const copy = structuredClone(gate);
  const root = copy.gateRoot;
  delete copy.gateRoot;
  if (root !== kfdProductGateDigest(copy)) issues.push(issue("adopter-gate-root", "gateRoot", "adopter manifest gate root does not match its content"));
  if (gate.status !== "passed" || gate.qualifying !== false || gate.selfCertified !== false || (gate.issues || []).length !== 0) {
    issues.push(issue("adopter-gate-status", "status", "release consumption requires a passing non-qualifying, non-self-certifying manifest gate"));
  }
  if (gate?.authority?.contract !== "kfd.adopter-conformance-manifest/v1"
    || !ROOT_PATTERN.test(text(gate?.authority?.manifestRoot))) {
    issues.push(issue("adopter-gate-authority", "authority", "adopter gate must bind the standard manifest contract and root"));
  }
  if (gate?.standardPackage?.name !== kfdPackageJson.name || gate?.standardPackage?.version !== kfdPackageJson.version
    || ![gate?.standardPackage?.artifactRoot, gate?.standardPackage?.registryRoot, gate?.standardPackage?.verifierSetRoot].every((value) => ROOT_PATTERN.test(text(value)))) {
    issues.push(issue("adopter-gate-package", "standardPackage", "adopter gate uses stale KFD package metadata"));
  }
  if (!SHA_PATTERN.test(text(gate?.source?.sha)) || !ROOT_PATTERN.test(text(gate?.source?.artifactRoot))) {
    issues.push(issue("adopter-gate-source", "source", "adopter gate must bind one exact Buildchain source commit and artifact root"));
  }
  if (gate?.decisionWitness?.rootAlgorithm !== "sha256-buildchain-stable-json-v1"
    || !ROOT_PATTERN.test(text(gate?.decisionWitness?.root))
    || !ROOT_PATTERN.test(text(gate?.manifestVerificationReportRoot))
    || !ROOT_PATTERN.test(text(gate?.manifestBundleRoot))) {
    issues.push(issue("adopter-gate-evidence-root", "", "decision, report, and bundle roots are required"));
  }
}

function validateProjectedGates(gate, expectedSourceSha, issues) {
  const seenStandards = new Set();
  for (const [index, productGate] of (gate.gateResults || []).entries()) {
    if (!PRODUCT_GATE_SET.has(productGate?.standard) || productGate?.status !== "passed" || !ROOT_PATTERN.test(text(productGate?.gateRoot))) {
      issues.push(issue("adopter-gate-result", `gateResults[${index}]`, "KFD-4/5/7 gate projections must be passing and rooted"));
    }
    if (seenStandards.has(productGate?.standard)) issues.push(issue("adopter-gate-result-set", `gateResults[${index}]`, "product gate standards must be unique"));
    seenStandards.add(productGate?.standard);
    if (productGate?.sourceSha !== gate?.source?.sha || (expectedSourceSha && productGate?.sourceSha !== expectedSourceSha)) {
      issues.push(issue("adopter-gate-source", `gateResults[${index}].sourceSha`, "product gate source must match the release source"));
    }
  }
  if (seenStandards.size !== PRODUCT_GATE_STANDARDS.length || PRODUCT_GATE_STANDARDS.some((standard) => !seenStandards.has(standard))) {
    issues.push(issue("adopter-gate-result-set", "gateResults", "adopter gate must contain exactly one KFD-4, KFD-5, and KFD-7 product gate"));
  }
}

export function validateKfdAdopterManifestGate(gate, {
  expectedSourceSha = "",
  checkedAt = gate?.checkedAt || new Date().toISOString(),
} = {}) {
  const issues = [];
  if (!gate || gate.schemaVersion !== 1 || gate.contract !== KFD_ADOPTER_MANIFEST_GATE_CONTRACT) {
    return { valid: false, issues: [issue("adopter-gate-contract", "", `gate must use ${KFD_ADOPTER_MANIFEST_GATE_CONTRACT} v1`)] };
  }
  validateGateDocument(gate, issues);
  validateProjectedGates(gate, expectedSourceSha, issues);
  if (gate.checkedAt !== checkedAt || gate?.verificationCut?.checkedAt !== checkedAt || !Number.isFinite(Date.parse(checkedAt))
    || !Number.isSafeInteger(gate?.verificationCut?.maxAgeSeconds) || gate.verificationCut.maxAgeSeconds < 0) {
    issues.push(issue("adopter-gate-time", "verificationCut", "adopter gate verification cut does not match the requested cut"));
  }
  return { valid: issues.length === 0, issues };
}

function legacyStatus(row) {
  if (row.state === "adopted") return "source-supported-release-bound";
  if (row.state === "candidate") return "candidate";
  if (row.state === "draft-evidence") return "draft-adopter-evidence";
  return row.state;
}

function legacyRow(row, gates) {
  const key = row.id.toLowerCase();
  const productGate = gates.get(key);
  return {
    id: row.id,
    key,
    title: standardMetadata(key).title,
    supportStatus: legacyStatus(row),
    normative: { status: row.registryStatus, revision: standardMetadata(key).revision },
    implementation: { status: row.implementationEvidence.length > 0 ? "implemented" : "not-declared" },
    verification: { status: row.verificationEvidence.length > 0 || row.witnessBindings.length > 0 ? "passed" : "not-declared" },
    buildchain: {
      protocol: productGate ? `${KFD_PRODUCT_GATE_CONTRACT}/v1` : `${KFD_ADOPTER_MANIFEST_GATE_CONTRACT}/v1`,
      gateStatus: productGate?.status || "manifest-verified",
    },
    releaseQualification: { shippedSupport: false },
    claimClass: "standard-adopter-manifest-projection",
    knownLimitations: [...row.gaps],
    owner: BUILDCHAIN_ADOPTER_ID,
    nextGate: "Release Passport artifact binding and independent release decision",
    declaration: { state: row.state, usage: row.usage, root: kfdProductGateDigest(decisionWitnessRow(row)) },
  };
}

export function createKfdLegacySupportMatrixProjection({ manifest, manifestGate } = {}) {
  const validation = validateKfdAdopterManifestGate(manifestGate, {
    expectedSourceSha: manifestGate?.source?.sha,
    checkedAt: manifestGate?.checkedAt,
  });
  if (!validation.valid || manifest?.contract !== "kfd.adopter-conformance-manifest/v1") {
    throw new Error("legacy support projection requires the exact passing standard adopter manifest authority");
  }
  const authorityIssues = [];
  const bundle = verifyPublishedManifest(manifest, {
    packageArtifactRoot: manifestGate.standardPackage.artifactRoot,
    verifiedAt: manifestGate.verificationCut.checkedAt,
    maxAgeSeconds: manifestGate.verificationCut.maxAgeSeconds,
  }, authorityIssues);
  const sourceSha = validateManifestIdentity(manifest, manifestGate.standardPackage.artifactRoot, manifestGate.source.sha, authorityIssues);
  const decisionRoot = kfdProductGateDigest(manifest.decisions.map(decisionWitnessRow));
  if (!bundle || sourceSha !== manifestGate.source.sha || manifest.adopter.artifact.root !== manifestGate.source.artifactRoot
    || bundle.roots.manifestRoot !== manifestGate.authority.manifestRoot
    || bundle.roots.verificationReportRoot !== manifestGate.manifestVerificationReportRoot
    || bundle.bundleRoot !== manifestGate.manifestBundleRoot
    || decisionRoot !== manifestGate.decisionWitness.root
    || manifest.kfdCut.registry.root !== manifestGate.standardPackage.registryRoot
    || manifest.kfdCut.verifierSetRoot !== manifestGate.standardPackage.verifierSetRoot) {
    authorityIssues.push(issue("legacy-projection-authority", "manifest", "manifest does not match the exact gate authority closure"));
  }
  const gates = new Map(manifestGate.gateResults.map((entry) => [entry.standard, entry]));
  for (const [standard, gate] of gates) {
    const row = manifest.decisions.find((entry) => entry.id === standard.toUpperCase());
    if (!(row?.verificationEvidence || []).some((entry) => entry?.root === gate.gateRoot)) {
      authorityIssues.push(issue("legacy-projection-gate-binding", `manifest.decisions.${standard.toUpperCase()}`, "manifest does not bind the projected product gate root"));
    }
  }
  if (authorityIssues.length > 0) throw new Error(`legacy support projection authority failed: ${JSON.stringify(authorityIssues)}`);
  return {
    schemaVersion: 1,
    contract: KFD_LEGACY_SUPPORT_MATRIX_CONTRACT,
    authority: {
      path: manifestGate.authority.path,
      contract: manifest.contract,
      root: manifestGate.authority.manifestRoot,
      gateRoot: manifestGate.gateRoot,
    },
    upstream: {
      package: manifestGate.standardPackage.name,
      version: manifestGate.standardPackage.version,
      artifactRoot: manifestGate.standardPackage.artifactRoot,
      registryRoot: manifestGate.standardPackage.registryRoot,
      verifierSetRoot: manifestGate.standardPackage.verifierSetRoot,
      standardsSha256: standardsFileDigest(),
    },
    rows: manifest.decisions.map((row) => legacyRow(row, gates)),
  };
}

export function validateKfdLegacySupportMatrixProjection(matrix, { manifest, manifestGate } = {}) {
  try {
    const expected = createKfdLegacySupportMatrixProjection({ manifest, manifestGate });
    return kfdProductGateDigest(matrix) === kfdProductGateDigest(expected)
      ? { valid: true, issues: [] }
      : { valid: false, issues: [issue("legacy-projection-drift", "", "legacy support matrix differs from the sole standard adopter manifest projection")] };
  } catch (error) {
    return { valid: false, issues: [issue("legacy-projection-authority", "", error.message)] };
  }
}
