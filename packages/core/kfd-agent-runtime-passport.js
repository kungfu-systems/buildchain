import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import kfdPackageJson from "@kungfu-tech/kfd-agent-runtime/package.json" with { type: "json" };

export const KFD_AGENT_RUNTIME_WITNESS_CONTRACT =
  "kungfu-buildchain-kfd-agent-runtime-witness/v1";
export const KFD_AGENT_RUNTIME_PASSPORT_CONTRACT =
  "kungfu-buildchain-kfd-agent-runtime-passport/v1";
export const KFD_AGENT_RUNTIME_SECTION_KEY = "kfd-agent-runtime";
export const KFD_AGENT_RUNTIME_CLAIM_LEVELS = Object.freeze([
  "tested",
  "independently-verified",
  "reference-adopter",
  "externally-adopted",
]);

const require = createRequire(import.meta.url);
const KFD_VERIFIER_MODE = "packaged-offline-wasm";
const KFD_VERIFIER_AUTHORITY = "@kungfu-tech/kfd";
const EMBEDDED_KFD_VERIFIER_WASM_BASE64 =
  typeof __BUILDCHAIN_EMBEDDED_KFD_AGENT_RUNTIME_WASM_BASE64__ === "string"
    ? __BUILDCHAIN_EMBEDDED_KFD_AGENT_RUNTIME_WASM_BASE64__
    : "";

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return sha256Bytes(stableJson(value));
}

function normalizeSha256(value) {
  return optionalString(value)
    .replace(/^sha256:/, "")
    .toLowerCase();
}

function digest(value) {
  const normalized = normalizeSha256(value);
  return normalized ? `sha256:${normalized}` : "";
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(normalizeSha256(value));
}

function isGitSha(value) {
  return /^[0-9a-f]{40}$/.test(optionalString(value));
}

function issue(code, message, details = {}) {
  return { level: "error", code, message, details };
}

function repoRelativePath(value, label) {
  const normalized = optionalString(value).replace(/\\/g, "/");
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return normalized;
}

function readJsonEvidence(cwd, descriptor, label) {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor)
  ) {
    throw new Error(`${label} must be an object`);
  }
  const relativePath = repoRelativePath(descriptor.path, `${label}.path`);
  const filePath = path.resolve(cwd, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return {
      path: relativePath,
      expectedSha256: digest(descriptor.sha256),
      fileSha256: "",
      canonicalSha256: "",
      value: undefined,
      text: "",
    };
  }
  const text = fs.readFileSync(filePath, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return {
    path: relativePath,
    expectedSha256: digest(descriptor.sha256),
    fileSha256: digest(sha256Bytes(text)),
    canonicalSha256: digest(sha256Json(value)),
    value,
    text,
  };
}

function verifierWasmBytes() {
  if (EMBEDDED_KFD_VERIFIER_WASM_BASE64) {
    return Buffer.from(EMBEDDED_KFD_VERIFIER_WASM_BASE64, "base64");
  }
  return fs.readFileSync(
    require.resolve("@kungfu-tech/kfd-agent-runtime/verifier/wasm"),
  );
}

function verifyWithPackagedKfd(reportText) {
  const wasmBytes = verifierWasmBytes();
  const module = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(module, {});
  const {
    memory,
    kfd_alloc: alloc,
    kfd_free: free,
    kfd_verify: verify,
  } = instance.exports;
  const bundle = JSON.stringify({
    schemaVersion: 1,
    contract: "kfd.verification-bundle/v1",
    kind: "agent-runtime-report",
    primary: reportText,
    artifacts: {},
  });
  const input = new TextEncoder().encode(bundle);
  const inputPointer = alloc(input.length);
  new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
  let packed;
  try {
    packed = verify(inputPointer, input.length);
  } finally {
    free(inputPointer, input.length);
  }
  const outputPointer = Number(packed >> 32n);
  const outputLength = Number(packed & 0xffffffffn);
  const output = new Uint8Array(
    memory.buffer,
    outputPointer,
    outputLength,
  ).slice();
  free(outputPointer, outputLength);
  const text = new TextDecoder().decode(output);
  return {
    report: JSON.parse(text),
    reportSha256: digest(sha256Bytes(text)),
    canonicalSha256: digest(sha256Json(JSON.parse(text))),
    verifier: {
      authority: KFD_VERIFIER_AUTHORITY,
      mode: KFD_VERIFIER_MODE,
      packageVersion: kfdPackageJson.version,
      wasmSha256: digest(sha256Bytes(wasmBytes)),
    },
  };
}

function platformId(platform = {}) {
  return `${optionalString(platform.os)}/${optionalString(platform.arch)}`;
}

function normalizeReleaseArtifact(artifact = {}) {
  return {
    name: optionalString(artifact.name),
    sha256: digest(artifact.sha256 || artifact.digest),
    platform: optionalString(artifact.platform),
    ref: optionalString(artifact.ref),
  };
}

function validatePlan(witness, issues) {
  const plan =
    witness.plan &&
    typeof witness.plan === "object" &&
    !Array.isArray(witness.plan)
      ? witness.plan
      : {};
  const profile =
    plan.profile && typeof plan.profile === "object" ? plan.profile : {};
  const suite = plan.suite && typeof plan.suite === "object" ? plan.suite : {};
  const requiredPlatforms = Array.isArray(plan.requiredPlatforms)
    ? plan.requiredPlatforms
    : [];
  const claimLevel = optionalString(plan.claimLevel);
  for (const [field, value] of [
    ["profile.id", profile.id],
    ["profile.version", profile.version],
    ["profile.manifestDigest", profile.manifestDigest],
    ["suite.id", suite.id],
    ["suite.version", suite.version],
    ["suite.vectorRoot", suite.vectorRoot],
  ]) {
    if (!optionalString(value)) {
      issues.push(
        issue(`kfd-agent-runtime.plan.${field}`, `plan.${field} is required`),
      );
    }
  }
  if (!isSha256(profile.manifestDigest)) {
    issues.push(
      issue(
        "kfd-agent-runtime.plan.profile.manifest-digest",
        "plan.profile.manifestDigest must be an exact sha256 root",
      ),
    );
  }
  if (!isSha256(suite.vectorRoot)) {
    issues.push(
      issue(
        "kfd-agent-runtime.plan.suite.vector-root",
        "plan.suite.vectorRoot must be an exact sha256 root",
      ),
    );
  }
  if (requiredPlatforms.length === 0) {
    issues.push(
      issue(
        "kfd-agent-runtime.plan.platforms",
        "plan.requiredPlatforms must declare at least one os/arch pair",
      ),
    );
  }
  const platformIds = requiredPlatforms.map(platformId);
  if (
    platformIds.some((id) => id === "/") ||
    new Set(platformIds).size !== platformIds.length
  ) {
    issues.push(
      issue(
        "kfd-agent-runtime.plan.platforms",
        "plan.requiredPlatforms must contain unique non-empty os/arch pairs",
      ),
    );
  }
  if (!KFD_AGENT_RUNTIME_CLAIM_LEVELS.includes(claimLevel)) {
    issues.push(
      issue(
        "kfd-agent-runtime.plan.claim-level",
        `plan.claimLevel must be one of ${KFD_AGENT_RUNTIME_CLAIM_LEVELS.join(", ")}`,
      ),
    );
  }
  const verification =
    plan.verification && typeof plan.verification === "object"
      ? plan.verification
      : {};
  if (
    verification.authority !== KFD_VERIFIER_AUTHORITY ||
    verification.mode !== KFD_VERIFIER_MODE
  ) {
    issues.push(
      issue(
        "kfd-agent-runtime.independent-verifier-required",
        `plan.verification must require ${KFD_VERIFIER_AUTHORITY} ${KFD_VERIFIER_MODE}; producer-only verification is not qualifying`,
      ),
    );
  }
  return {
    profile: {
      id: optionalString(profile.id),
      version: optionalString(profile.version),
      manifestDigest: digest(profile.manifestDigest),
    },
    suite: {
      id: optionalString(suite.id),
      version: optionalString(suite.version),
      vectorRoot: digest(suite.vectorRoot),
    },
    requiredPlatforms: requiredPlatforms.map((platform) => ({
      os: optionalString(platform.os),
      arch: optionalString(platform.arch),
    })),
    claimLevel,
    verification: {
      authority: optionalString(verification.authority),
      mode: optionalString(verification.mode),
    },
  };
}

function validateAdoptionEvidence({
  witness,
  product,
  source,
  claimLevel,
  issues,
}) {
  const requestedIndex = KFD_AGENT_RUNTIME_CLAIM_LEVELS.indexOf(claimLevel);
  const adoption =
    witness.adoption && typeof witness.adoption === "object"
      ? witness.adoption
      : {};
  const reference = adoption.referenceAdopter;
  const external = adoption.externalAdoption;
  let referencePassed = false;
  let externalPassed = false;
  if (
    requestedIndex >=
    KFD_AGENT_RUNTIME_CLAIM_LEVELS.indexOf("reference-adopter")
  ) {
    if (
      !reference ||
      reference.contract !==
        "kungfu-buildchain-reference-adopter-evidence/v1" ||
      reference.reviewedSourceSha !== source.sha ||
      !isSha256(reference.reviewRoot) ||
      !optionalString(reference.publicUrl) ||
      !optionalString(reference.reviewer?.id) ||
      !optionalString(reference.reviewer?.source) ||
      reference.reviewer.source === product.repository
    ) {
      issues.push(
        issue(
          "kfd-agent-runtime.reference-adopter-evidence",
          "reference-adopter requires exact-source independent review evidence from a different actor source and a public coordinate",
        ),
      );
    } else {
      referencePassed = true;
    }
  }
  if (
    requestedIndex >=
    KFD_AGENT_RUNTIME_CLAIM_LEVELS.indexOf("externally-adopted")
  ) {
    if (
      !external ||
      external.contract !== "kungfu-buildchain-external-adoption-evidence/v1" ||
      !optionalString(external.adopter?.id) ||
      !optionalString(external.adopter?.repository) ||
      external.adopter.repository === product.repository ||
      !optionalString(external.publicUrl) ||
      !isSha256(external.evidenceRoot)
    ) {
      issues.push(
        issue(
          "kfd-agent-runtime.external-adoption-evidence",
          "externally-adopted requires a distinct adopter repository, public coordinate, and exact evidence root",
        ),
      );
    } else {
      externalPassed = true;
    }
  }
  return {
    reference: reference ? structuredClone(reference) : undefined,
    external: external ? structuredClone(external) : undefined,
    referencePassed,
    externalPassed,
  };
}

function claimStatus({ level, requestedLevel, passed }) {
  const requestedIndex = KFD_AGENT_RUNTIME_CLAIM_LEVELS.indexOf(requestedLevel);
  const levelIndex = KFD_AGENT_RUNTIME_CLAIM_LEVELS.indexOf(level);
  if (levelIndex > requestedIndex) return "not-claimed";
  return passed ? "passed" : "failed";
}

function createClaims({
  requestedLevel,
  testedPassed,
  independentPassed,
  referencePassed,
  externalPassed,
}) {
  return KFD_AGENT_RUNTIME_CLAIM_LEVELS.map((level) => {
    const passed = {
      tested: testedPassed,
      "independently-verified": testedPassed && independentPassed,
      "reference-adopter": testedPassed && independentPassed && referencePassed,
      "externally-adopted":
        testedPassed && independentPassed && referencePassed && externalPassed,
    }[level];
    return {
      level,
      status: claimStatus({ level, requestedLevel, passed }),
      inferred: false,
    };
  });
}

function normalizeWitness(raw, { cwd, artifacts, verifiedAt }) {
  const issues = [];
  const witness =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (
    witness.schemaVersion !== 1 ||
    witness.contract !== KFD_AGENT_RUNTIME_WITNESS_CONTRACT
  ) {
    issues.push(
      issue(
        "kfd-agent-runtime.witness.contract",
        `witness must use ${KFD_AGENT_RUNTIME_WITNESS_CONTRACT} schemaVersion 1`,
      ),
    );
  }
  const product = {
    id: optionalString(witness.product?.id),
    repository: optionalString(witness.product?.repository),
  };
  const source = {
    sha: optionalString(witness.source?.sha),
    tree: optionalString(witness.source?.tree),
    projectCut: digest(witness.source?.projectCut),
  };
  if (!product.id || !product.repository) {
    issues.push(
      issue(
        "kfd-agent-runtime.product",
        "product.id and product.repository are required",
      ),
    );
  }
  if (!isGitSha(source.sha)) {
    issues.push(
      issue(
        "kfd-agent-runtime.source.sha",
        "source.sha must be an exact 40-character Git commit",
      ),
    );
  }
  if (source.tree && !isGitSha(source.tree)) {
    issues.push(
      issue(
        "kfd-agent-runtime.source.tree",
        "source.tree must be an exact 40-character Git tree",
      ),
    );
  }
  if (witness.source?.projectCut && !isSha256(source.projectCut)) {
    issues.push(
      issue(
        "kfd-agent-runtime.source.project-cut",
        "source.projectCut must be an exact sha256 root when supplied",
      ),
    );
  }
  const plan = validatePlan(witness, issues);
  const releaseArtifacts = (artifacts || []).map(normalizeReleaseArtifact);
  const reportDescriptors = Array.isArray(witness.reports)
    ? witness.reports
    : [];
  if (reportDescriptors.length === 0) {
    issues.push(
      issue(
        "kfd-agent-runtime.reports.empty",
        "at least one KFD Agent Runtime report is required",
      ),
    );
  }
  const observedPlatforms = new Set();
  const reports = reportDescriptors.map((descriptor, index) => {
    const label = `reports[${index}]`;
    const evidence = readJsonEvidence(
      cwd,
      descriptor.report,
      `${label}.report`,
    );
    const reportIssues = [];
    if (!evidence.value) {
      reportIssues.push(
        issue(
          "kfd-agent-runtime.report.missing",
          `${label} report file is missing`,
          { path: evidence.path },
        ),
      );
    }
    if (
      !isSha256(evidence.expectedSha256) ||
      evidence.expectedSha256 !== evidence.fileSha256
    ) {
      reportIssues.push(
        issue(
          "kfd-agent-runtime.report.digest",
          `${label} report digest does not match`,
          {
            expected: evidence.expectedSha256,
            actual: evidence.fileSha256,
          },
        ),
      );
    }
    const report = evidence.value || {};
    const reportPlatform = platformId(report.platform);
    if (reportPlatform !== "/" && observedPlatforms.has(reportPlatform)) {
      reportIssues.push(
        issue(
          "kfd-agent-runtime.platform.duplicate",
          `multiple reports claim ${reportPlatform}`,
        ),
      );
    }
    observedPlatforms.add(reportPlatform);
    if (
      report.contract !== "kfd.agent-runtime-report/v1" ||
      report.valid !== true ||
      report.qualifying !== false ||
      report.selfCertified !== false
    ) {
      reportIssues.push(
        issue(
          "kfd-agent-runtime.report.boundary",
          `${label} must be a valid, non-qualifying, non-self-certified KFD Agent Runtime report`,
        ),
      );
    }
    for (const [field, expected, actual] of [
      ["profile.id", plan.profile.id, report.profile?.id],
      ["profile.version", plan.profile.version, report.profile?.version],
      [
        "profile.manifestDigest",
        plan.profile.manifestDigest,
        digest(report.profile?.manifestDigest),
      ],
      ["suite.id", plan.suite.id, report.suite?.id],
      ["suite.version", plan.suite.version, report.suite?.version],
      [
        "suite.vectorRoot",
        plan.suite.vectorRoot,
        digest(report.suite?.vectorRoot),
      ],
      ["adapter.sourceCommit", source.sha, report.adapter?.sourceCommit],
    ]) {
      if (optionalString(actual) !== optionalString(expected)) {
        reportIssues.push(
          issue(
            `kfd-agent-runtime.report.${field}`,
            `${label} ${field} does not match the release plan`,
            { expected, actual },
          ),
        );
      }
    }
    if (
      !plan.requiredPlatforms.some(
        (platform) => platformId(platform) === reportPlatform,
      )
    ) {
      reportIssues.push(
        issue(
          "kfd-agent-runtime.platform.scope-widening",
          `${label} platform ${reportPlatform} is outside the declared release plan`,
        ),
      );
    }
    if (
      report.partitions?.core?.status !== "pass" ||
      report.partitions?.core?.failed !== 0 ||
      report.partitions?.core?.passed !== report.partitions?.core?.total
    ) {
      reportIssues.push(
        issue(
          "kfd-agent-runtime.core.failed",
          `${label} Core partition is not a complete pass`,
        ),
      );
    }
    const artifact = {
      name: optionalString(descriptor.artifact?.name),
      sha256: digest(descriptor.artifact?.sha256),
    };
    const releaseArtifact = releaseArtifacts.find(
      (candidate) => candidate.name === artifact.name,
    );
    if (
      !artifact.name ||
      !isSha256(artifact.sha256) ||
      artifact.sha256 !== digest(report.adapter?.artifactDigest) ||
      !releaseArtifact ||
      releaseArtifact.sha256 !== artifact.sha256
    ) {
      reportIssues.push(
        issue(
          "kfd-agent-runtime.artifact.binding",
          `${label} adapter digest must match an exact release artifact`,
          {
            name: artifact.name,
            declared: artifact.sha256,
            report: digest(report.adapter?.artifactDigest),
            releaseArtifact: releaseArtifact?.sha256 || "",
          },
        ),
      );
    }
    let independent;
    if (evidence.text) {
      try {
        independent = verifyWithPackagedKfd(evidence.text);
      } catch (error) {
        reportIssues.push(
          issue(
            "kfd-agent-runtime.verifier.execution",
            `${label} packaged KFD verifier failed: ${error.message}`,
          ),
        );
      }
    }
    if (
      !independent ||
      independent.report?.contract !== "kfd.verification-report/v1" ||
      independent.report?.profile !== "kfd.agent-runtime-report/v1" ||
      independent.report?.valid !== true ||
      independent.report?.offline !== true ||
      independent.report?.qualifying !== false ||
      independent.report?.selfCertified !== false ||
      !Array.isArray(independent.report?.checks) ||
      independent.report.checks.some((check) => check.status !== "pass") ||
      !Array.isArray(independent.report?.issues) ||
      independent.report.issues.length > 0
    ) {
      reportIssues.push(
        issue(
          "kfd-agent-runtime.verifier.invalid",
          `${label} was not accepted by the packaged independent KFD verifier`,
        ),
      );
    }
    issues.push(...reportIssues);
    return {
      id: optionalString(descriptor.id || `report-${index + 1}`),
      platform: {
        os: optionalString(report.platform?.os),
        arch: optionalString(report.platform?.arch),
        runtime: optionalString(report.platform?.runtime),
      },
      report: {
        path: evidence.path,
        fileSha256: evidence.fileSha256,
        canonicalSha256: evidence.canonicalSha256,
        value: report,
      },
      adapterArtifact: artifact,
      independentVerification: independent,
      core: report.partitions?.core || {},
      experimental: {
        ...(report.partitions?.experimental || {}),
        normative: false,
      },
      status: reportIssues.length === 0 ? "passed" : "failed",
    };
  });
  for (const platform of plan.requiredPlatforms) {
    if (!observedPlatforms.has(platformId(platform))) {
      issues.push(
        issue(
          "kfd-agent-runtime.platform.missing",
          `required platform ${platformId(platform)} has no report`,
        ),
      );
    }
  }
  const testedPassed =
    reports.length > 0 &&
    reports.every((report) => {
      const value = report.report.value;
      return (
        value?.valid === true &&
        value?.partitions?.core?.status === "pass" &&
        report.adapterArtifact.name &&
        isSha256(report.adapterArtifact.sha256)
      );
    });
  const independentPassed =
    plan.verification.authority === KFD_VERIFIER_AUTHORITY &&
    plan.verification.mode === KFD_VERIFIER_MODE &&
    reports.length > 0 &&
    reports.every(
      (report) =>
        report.independentVerification?.report?.valid === true &&
        report.independentVerification?.report?.offline === true,
    );
  const adoption = validateAdoptionEvidence({
    witness,
    product,
    source,
    claimLevel: plan.claimLevel,
    issues,
  });
  const claims = createClaims({
    requestedLevel: plan.claimLevel,
    testedPassed,
    independentPassed,
    referencePassed: adoption.referencePassed,
    externalPassed: adoption.externalPassed,
  });
  const requestedClaim = claims.find(
    (claim) => claim.level === plan.claimLevel,
  );
  return {
    id: optionalString(witness.id || product.id),
    status:
      issues.length === 0 && requestedClaim?.status === "passed"
        ? "passed"
        : "failed",
    verifiedAt,
    witnessSha256: digest(sha256Json(witness)),
    product,
    source,
    plan,
    reports,
    claims,
    adoption: {
      ...(adoption.reference ? { referenceAdopter: adoption.reference } : {}),
      ...(adoption.external ? { externalAdoption: adoption.external } : {}),
    },
    nonClaims: Array.isArray(witness.nonClaims)
      ? witness.nonClaims.map(optionalString).filter(Boolean)
      : [],
    issues,
  };
}

export function createKfdAgentRuntimePassportEvidence({
  cwd = process.cwd(),
  artifacts = [],
  witnesses = [],
  verifiedAt = new Date().toISOString(),
} = {}) {
  const normalized = (witnesses || [])
    .filter(Boolean)
    .map((witness) =>
      normalizeWitness(witness, { cwd, artifacts, verifiedAt }),
    );
  if (normalized.length === 0) return undefined;
  const status = normalized.every((witness) => witness.status === "passed")
    ? "passed"
    : "failed";
  return {
    key: KFD_AGENT_RUNTIME_SECTION_KEY,
    passportSection: {
      schemaVersion: 1,
      contract: KFD_AGENT_RUNTIME_PASSPORT_CONTRACT,
      status,
      gateResult: status === "passed" ? "pass" : "fail",
      verifiedAt,
      verifierAuthority: {
        owner: KFD_VERIFIER_AUTHORITY,
        mode: KFD_VERIFIER_MODE,
        packageVersion: kfdPackageJson.version,
        responsibility:
          "KFD owns report schema, fixed suite roots, and offline verifier semantics; Buildchain owns release binding and claim publication.",
      },
      claimPolicy: {
        levels: [...KFD_AGENT_RUNTIME_CLAIM_LEVELS],
        inference: "forbidden",
        experimentalPartition:
          "reported separately and never upgrades a normative Core or adoption claim",
      },
      witnesses: normalized,
    },
  };
}

export function validateKfdAgentRuntimePassportEvidence(
  section,
  { artifacts = [] } = {},
) {
  if (!section) return [];
  const issues = [];
  if (
    typeof section !== "object" ||
    Array.isArray(section) ||
    section.schemaVersion !== 1 ||
    section.contract !== KFD_AGENT_RUNTIME_PASSPORT_CONTRACT
  ) {
    return [
      issue(
        "kfd-agent-runtime.passport.contract",
        `section must use ${KFD_AGENT_RUNTIME_PASSPORT_CONTRACT} schemaVersion 1`,
      ),
    ];
  }
  if (
    section.verifierAuthority?.owner !== KFD_VERIFIER_AUTHORITY ||
    section.verifierAuthority?.mode !== KFD_VERIFIER_MODE ||
    section.verifierAuthority?.packageVersion !== kfdPackageJson.version
  ) {
    issues.push(
      issue(
        "kfd-agent-runtime.passport.verifier-authority",
        "passport verifier authority must match the installed KFD package",
      ),
    );
  }
  const releaseArtifacts = artifacts.map(normalizeReleaseArtifact);
  const witnesses = Array.isArray(section.witnesses) ? section.witnesses : [];
  if (witnesses.length === 0) {
    issues.push(
      issue(
        "kfd-agent-runtime.passport.witnesses",
        "passport must retain at least one runtime witness",
      ),
    );
  }
  for (const [witnessIndex, witness] of witnesses.entries()) {
    const witnessIssues = [];
    if (
      !optionalString(witness.product?.id) ||
      !optionalString(witness.product?.repository) ||
      !isGitSha(witness.source?.sha)
    ) {
      witnessIssues.push(
        issue(
          `kfd-agent-runtime.passport.witnesses[${witnessIndex}].identity`,
          "retained witness must preserve product coordinates and an exact source commit",
        ),
      );
    }
    const plan = validatePlan(witness, witnessIssues);
    const reports = Array.isArray(witness.reports) ? witness.reports : [];
    const observedPlatforms = new Set();
    let reportClosurePassed = reports.length > 0 && witnessIssues.length === 0;
    let independentPassed = reports.length > 0;
    const requestedClaim = (witness.claims || []).find(
      (claim) => claim.level === plan.claimLevel,
    );
    if (
      witness.status !== "passed" ||
      witness.issues?.length > 0 ||
      requestedClaim?.status !== "passed" ||
      requestedClaim?.inferred !== false
    ) {
      issues.push(
        issue(
          `kfd-agent-runtime.passport.witnesses[${witnessIndex}].failed`,
          "runtime witness did not satisfy its explicitly requested claim",
        ),
      );
    }
    for (const [reportIndex, entry] of reports.entries()) {
      const report = entry.report?.value || {};
      const reportPlatform = platformId(report.platform);
      observedPlatforms.add(reportPlatform);
      for (const [field, expected, actual] of [
        ["profile.id", plan.profile.id, report.profile?.id],
        ["profile.version", plan.profile.version, report.profile?.version],
        [
          "profile.manifestDigest",
          plan.profile.manifestDigest,
          digest(report.profile?.manifestDigest),
        ],
        ["suite.id", plan.suite.id, report.suite?.id],
        ["suite.version", plan.suite.version, report.suite?.version],
        [
          "suite.vectorRoot",
          plan.suite.vectorRoot,
          digest(report.suite?.vectorRoot),
        ],
        ["adapter.sourceCommit", witness.source?.sha, report.adapter?.sourceCommit],
      ]) {
        if (optionalString(actual) !== optionalString(expected)) {
          reportClosurePassed = false;
          witnessIssues.push(
            issue(
              `kfd-agent-runtime.passport.witnesses[${witnessIndex}].reports[${reportIndex}].${field}`,
              `embedded report ${field} no longer matches its release plan`,
              { expected, actual },
            ),
          );
        }
      }
      if (
        !plan.requiredPlatforms.some(
          (platform) => platformId(platform) === reportPlatform,
        ) ||
        report.partitions?.core?.status !== "pass" ||
        report.partitions?.core?.failed !== 0 ||
        report.partitions?.core?.passed !== report.partitions?.core?.total ||
        entry.experimental?.normative !== false
      ) {
        reportClosurePassed = false;
        witnessIssues.push(
          issue(
            `kfd-agent-runtime.passport.witnesses[${witnessIndex}].reports[${reportIndex}].scope`,
            "embedded report platform, Core closure, or Experimental boundary drifted",
          ),
        );
      }
      if (
        entry.report?.canonicalSha256 !==
        digest(sha256Json(report))
      ) {
        reportClosurePassed = false;
        witnessIssues.push(
          issue(
            `kfd-agent-runtime.passport.witnesses[${witnessIndex}].reports[${reportIndex}].digest`,
            "embedded KFD report canonical digest drifted",
          ),
        );
      }
      let independent;
      try {
        independent = verifyWithPackagedKfd(JSON.stringify(report));
      } catch {
        independent = undefined;
      }
      if (
        !independent ||
        independent.report?.valid !== true ||
        independent.canonicalSha256 !==
          entry.independentVerification?.canonicalSha256
      ) {
        independentPassed = false;
        witnessIssues.push(
          issue(
            `kfd-agent-runtime.passport.witnesses[${witnessIndex}].reports[${reportIndex}].verification`,
            "embedded KFD report no longer matches packaged independent verification",
          ),
        );
      }
      const artifact = releaseArtifacts.find(
        (candidate) => candidate.name === entry.adapterArtifact?.name,
      );
      if (
        !artifact ||
        artifact.sha256 !== digest(entry.adapterArtifact?.sha256) ||
        artifact.sha256 !== digest(report.adapter?.artifactDigest)
      ) {
        reportClosurePassed = false;
        witnessIssues.push(
          issue(
            `kfd-agent-runtime.passport.witnesses[${witnessIndex}].reports[${reportIndex}].artifact`,
            "embedded report adapter digest no longer matches the release artifact",
          ),
        );
      }
    }
    for (const platform of plan.requiredPlatforms) {
      if (!observedPlatforms.has(platformId(platform))) {
        reportClosurePassed = false;
        witnessIssues.push(
          issue(
            `kfd-agent-runtime.passport.witnesses[${witnessIndex}].platform`,
            `required platform ${platformId(platform)} is no longer retained`,
          ),
        );
      }
    }
    const adoption = validateAdoptionEvidence({
      witness,
      product: witness.product || {},
      source: witness.source || {},
      claimLevel: plan.claimLevel,
      issues: witnessIssues,
    });
    const expectedClaims = createClaims({
      requestedLevel: plan.claimLevel,
      testedPassed: reportClosurePassed,
      independentPassed,
      referencePassed: adoption.referencePassed,
      externalPassed: adoption.externalPassed,
    });
    for (const expected of expectedClaims) {
      const actual = (witness.claims || []).find(
        (claim) => claim.level === expected.level,
      );
      if (
        actual?.status !== expected.status ||
        actual?.inferred !== false
      ) {
        witnessIssues.push(
          issue(
            `kfd-agent-runtime.passport.witnesses[${witnessIndex}].claims.${expected.level}`,
            "retained claim no longer matches its evidence predicate",
            { expected, actual },
          ),
        );
      }
    }
    issues.push(...witnessIssues);
  }
  const expectedStatus =
    issues.length === 0 &&
    witnesses.every((witness) => witness.status === "passed")
      ? "passed"
      : "failed";
  if (section.status !== expectedStatus) {
    issues.push(
      issue(
        "kfd-agent-runtime.passport.status",
        "section status does not match its retained witnesses",
        { expected: expectedStatus, actual: section.status },
      ),
    );
  }
  if (section.gateResult !== (expectedStatus === "passed" ? "pass" : "fail")) {
    issues.push(
      issue(
        "kfd-agent-runtime.passport.gate-result",
        "section gateResult does not match its retained witnesses",
      ),
    );
  }
  return issues;
}
