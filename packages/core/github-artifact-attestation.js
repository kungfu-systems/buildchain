import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const GITHUB_ARTIFACT_ATTESTATION_POLICY_CONTRACT =
  "buildchain.github-artifact-attestation-policy/v1";
export const GITHUB_ARTIFACT_ATTESTATION_PREDICATE_CONTRACT =
  "buildchain.github-artifact-attestation-predicate/v1";
export const GITHUB_ARTIFACT_ATTESTATION_EVIDENCE_CONTRACT =
  "buildchain.github-artifact-attestation-evidence/v1";
export const GITHUB_ARTIFACT_ATTESTATION_VERIFICATION_CONTRACT =
  "buildchain.github-artifact-attestation-verification/v1";
export const GITHUB_ARTIFACT_ATTESTATION_PREDICATE_TYPE =
  "https://buildchain.libkungfu.dev/attestations/github-artifact/v1";
export const GITHUB_ARTIFACT_ATTESTATION_WORKFLOW =
  ".github/workflows/github-artifact-attestation.yml";

const SHA256 = /^sha256:([0-9a-f]{64})$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REQUIRED_PERMISSIONS = Object.freeze([
  "actions:read",
  "artifact-metadata:write",
  "attestations:write",
  "contents:read",
  "id-token:write",
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function string(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function sha256(value, label) {
  const normalized = string(value, label).toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(`${label} must be sha256:<64-lowercase-hex>`);
  return normalized;
}

function commit(value, label) {
  const normalized = string(value, label).toLowerCase();
  if (!COMMIT.test(normalized)) throw new Error(`${label} must be an exact 40-hex commit SHA`);
  return normalized;
}

function repository(value, label) {
  const normalized = string(value, label);
  if (!REPOSITORY.test(normalized)) throw new Error(`${label} must be owner/repository`);
  return normalized;
}

function relativeFile(value, label) {
  const normalized = string(value, label).replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized.endsWith("/")
  ) {
    throw new Error(`${label} must be a safe relative file path`);
  }
  return normalized;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function githubArtifactAttestationSha256Buffer(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export function githubArtifactAttestationSha256File(filePath) {
  return githubArtifactAttestationSha256Buffer(fs.readFileSync(filePath));
}

export function githubArtifactAttestationSemanticRoot(value) {
  return githubArtifactAttestationSha256Buffer(stableJson(value));
}

function normalizeSubject(value) {
  const subject = object(value, "policy.subject");
  const size = Number(subject.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("policy.subject.size must be a non-negative safe integer");
  }
  return {
    name: string(subject.name, "policy.subject.name"),
    path: relativeFile(subject.path, "policy.subject.path"),
    size,
    digest: sha256(subject.digest, "policy.subject.digest"),
    kind: "file",
  };
}

function normalizeCaller(value) {
  const caller = object(value, "policy.caller");
  return {
    repository: repository(caller.repository, "policy.caller.repository"),
    sourceSha: commit(caller.sourceSha, "policy.caller.sourceSha"),
    sourceTreeSha: commit(caller.sourceTreeSha, "policy.caller.sourceTreeSha"),
  };
}

function normalizeSigner(value) {
  const signer = object(value, "policy.signer");
  const signerRepository = repository(signer.repository, "policy.signer.repository");
  const workflowPath = relativeFile(signer.workflowPath, "policy.signer.workflowPath");
  if (signerRepository !== "kungfu-systems/buildchain") {
    throw new Error("policy.signer.repository must be kungfu-systems/buildchain");
  }
  if (workflowPath !== GITHUB_ARTIFACT_ATTESTATION_WORKFLOW) {
    throw new Error(`policy.signer.workflowPath must be ${GITHUB_ARTIFACT_ATTESTATION_WORKFLOW}`);
  }
  return {
    repository: signerRepository,
    workflowPath,
    workflowDigest: commit(signer.workflowDigest, "policy.signer.workflowDigest"),
    runner: "github-hosted-ubuntu",
  };
}

function normalizeBuild(value) {
  const build = object(value, "policy.build");
  const platform = string(build.platform, "policy.build.platform");
  if (!/^linux(?:-|$)/.test(platform)) {
    throw new Error("policy.build.platform must identify a Linux platform");
  }
  return {
    platform,
    platformManifestDigest: sha256(
      build.platformManifestDigest,
      "policy.build.platformManifestDigest",
    ),
    runnerReceiptRoot: sha256(build.runnerReceiptRoot, "policy.build.runnerReceiptRoot"),
    buildchainRuntimeSha: commit(build.buildchainRuntimeSha, "policy.build.buildchainRuntimeSha"),
  };
}

export function normalizeGitHubArtifactAttestationPolicy(value) {
  const policy = object(value, "policy");
  if (policy.contract !== GITHUB_ARTIFACT_ATTESTATION_POLICY_CONTRACT) {
    throw new Error(`policy.contract must be ${GITHUB_ARTIFACT_ATTESTATION_POLICY_CONTRACT}`);
  }
  if (policy.predicateType !== GITHUB_ARTIFACT_ATTESTATION_PREDICATE_TYPE) {
    throw new Error(`policy.predicateType must be ${GITHUB_ARTIFACT_ATTESTATION_PREDICATE_TYPE}`);
  }
  const permissions = [...new Set((policy.permissions || []).map(String))].sort();
  if (stableJson(permissions) !== stableJson(REQUIRED_PERMISSIONS)) {
    throw new Error(`policy.permissions must equal ${REQUIRED_PERMISSIONS.join(", ")}`);
  }
  const signer = normalizeSigner(policy.signer);
  const build = normalizeBuild(policy.build);
  return {
    contract: GITHUB_ARTIFACT_ATTESTATION_POLICY_CONTRACT,
    predicateType: GITHUB_ARTIFACT_ATTESTATION_PREDICATE_TYPE,
    subject: normalizeSubject(policy.subject),
    caller: normalizeCaller(policy.caller),
    signer,
    build,
    permissions,
    permissionReasons: {
      "actions:read": "download the exact retained build artifacts from the declared workflow run",
      "artifact-metadata:write": "required by actions/attest v4 to register artifact metadata",
      "attestations:write": "publish the signed GitHub artifact attestation",
      "contents:read": "load the exact Buildchain attester runtime without consumer checkout",
      "id-token:write": "mint the ephemeral GitHub OIDC identity used by Sigstore",
    },
    claims: {
      kind: "artifact-attestation-and-provenance",
      excludes: [
        "embedded-elf-signing",
        "apt-repository-signing",
        "rpm-package-signing",
        "vulnerability-freedom",
      ],
    },
  };
}

export function createGitHubArtifactAttestationPolicy(value) {
  return normalizeGitHubArtifactAttestationPolicy({
    contract: GITHUB_ARTIFACT_ATTESTATION_POLICY_CONTRACT,
    predicateType: GITHUB_ARTIFACT_ATTESTATION_PREDICATE_TYPE,
    permissions: REQUIRED_PERMISSIONS,
    ...value,
  });
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function stripSha256(value) {
  return String(value || "").replace(/^sha256:/, "");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
}

function findManifestFile(manifest, subjectPath) {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const entry = files.find((candidate) => String(candidate.path || "").replace(/\\/g, "/") === subjectPath);
  if (!entry) throw new Error(`platform manifest does not contain subject path ${subjectPath}`);
  return entry;
}

function findPassportPolicy(passport, expectedPolicy) {
  const policies = Array.isArray(passport.githubArtifactAttestations)
    ? passport.githubArtifactAttestations
    : [];
  const match = policies
    .map(normalizeGitHubArtifactAttestationPolicy)
    .find((candidate) => candidate.subject.name === expectedPolicy.subject.name);
  if (!match) {
    throw new Error(`release passport does not require attestation for ${expectedPolicy.subject.name}`);
  }
  assertEqual(stableJson(match), stableJson(expectedPolicy), "release passport attestation policy");
  return match;
}

export function prepareGitHubArtifactAttestation({
  subjectPath,
  platformManifestPath,
  releasePassportPath,
  policy,
  expectedBuildchainRef = "",
  expectedCallerRepository = "",
  expectedSourceSha = "",
} = {}) {
  const normalizedPolicy = normalizeGitHubArtifactAttestationPolicy(policy);
  if (expectedBuildchainRef) {
    assertEqual(
      normalizedPolicy.signer.workflowDigest,
      commit(expectedBuildchainRef, "expectedBuildchainRef"),
      "policy signer workflow digest",
    );
  }
  if (expectedCallerRepository) {
    assertEqual(
      normalizedPolicy.caller.repository,
      repository(expectedCallerRepository, "expectedCallerRepository"),
      "policy caller repository",
    );
  }
  if (expectedSourceSha) {
    assertEqual(
      normalizedPolicy.caller.sourceSha,
      commit(expectedSourceSha, "expectedSourceSha"),
      "policy caller source SHA",
    );
  }
  const resolvedSubject = path.resolve(string(subjectPath, "subjectPath"));
  const resolvedManifest = path.resolve(string(platformManifestPath, "platformManifestPath"));
  const resolvedPassport = path.resolve(string(releasePassportPath, "releasePassportPath"));
  if (!fs.statSync(resolvedSubject).isFile()) throw new Error("subjectPath must be a file");

  const subjectSize = fs.statSync(resolvedSubject).size;
  const subjectDigest = githubArtifactAttestationSha256File(resolvedSubject);
  assertEqual(subjectSize, normalizedPolicy.subject.size, "subject size");
  assertEqual(subjectDigest, normalizedPolicy.subject.digest, "subject digest");

  const manifestDigest = githubArtifactAttestationSha256File(resolvedManifest);
  assertEqual(
    manifestDigest,
    normalizedPolicy.build.platformManifestDigest,
    "platform manifest digest",
  );
  const manifest = object(readJson(resolvedManifest, "platform manifest"), "platform manifest");
  if (manifest.contract !== "kungfu-buildchain-artifact") {
    throw new Error("platform manifest contract must be kungfu-buildchain-artifact");
  }
  assertEqual(manifest.platform?.id, normalizedPolicy.build.platform, "platform manifest platform");
  assertEqual(manifest.git?.repository, normalizedPolicy.caller.repository, "platform manifest repository");
  assertEqual(String(manifest.git?.sha || "").toLowerCase(), normalizedPolicy.caller.sourceSha, "platform manifest source SHA");
  const manifestFile = findManifestFile(manifest, normalizedPolicy.subject.path);
  assertEqual(Number(manifestFile.size), subjectSize, "platform manifest subject size");
  assertEqual(
    `sha256:${String(manifestFile.sha256 || "").toLowerCase()}`,
    subjectDigest,
    "platform manifest subject digest",
  );

  const passport = object(readJson(resolvedPassport, "release passport"), "release passport");
  if (passport.contract !== "kungfu-buildchain-release-passport") {
    throw new Error("release passport contract must be kungfu-buildchain-release-passport");
  }
  findPassportPolicy(passport, normalizedPolicy);
  assertEqual(
    String(passport.release?.sourceSha || "").toLowerCase(),
    normalizedPolicy.caller.sourceSha,
    "release passport source SHA",
  );
  assertEqual(
    String(passport.release?.builtSourceTreeSha || passport.release?.sourceTreeSha || "").toLowerCase(),
    normalizedPolicy.caller.sourceTreeSha,
    "release passport source tree SHA",
  );
  const passportRoot = githubArtifactAttestationSha256File(resolvedPassport);
  const predicate = {
    contract: GITHUB_ARTIFACT_ATTESTATION_PREDICATE_CONTRACT,
    subject: normalizedPolicy.subject,
    caller: normalizedPolicy.caller,
    signer: normalizedPolicy.signer,
    build: normalizedPolicy.build,
    releasePassport: {
      name: path.basename(resolvedPassport),
      digest: passportRoot,
    },
  };
  return {
    contract: "buildchain.github-artifact-attestation-preparation/v1",
    policy: normalizedPolicy,
    subjectPath: resolvedSubject,
    platformManifestPath: resolvedManifest,
    releasePassportPath: resolvedPassport,
    predicateType: GITHUB_ARTIFACT_ATTESTATION_PREDICATE_TYPE,
    predicate,
    predicateRoot: githubArtifactAttestationSemanticRoot(predicate),
  };
}

function decodeBundleStatement(bundle) {
  const envelope = bundle?.dsseEnvelope || bundle?.dsse_envelope;
  if (!envelope?.payload) throw new Error("attestation bundle is missing dsseEnvelope.payload");
  try {
    return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`attestation bundle payload is invalid: ${error.message}`);
  }
}

function validateStatement(statement, preparation) {
  assertEqual(statement?.predicateType, preparation.predicateType, "attestation predicate type");
  const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
  const subject = subjects.find((entry) => entry.name === preparation.policy.subject.name);
  if (!subject) throw new Error("attestation statement is missing the expected subject");
  assertEqual(
    String(subject.digest?.sha256 || "").toLowerCase(),
    stripSha256(preparation.policy.subject.digest),
    "attestation subject digest",
  );
  assertEqual(stableJson(statement.predicate), stableJson(preparation.predicate), "attestation predicate");
}

export function createGitHubArtifactAttestationEvidence({
  preparation,
  attestationId,
  attestationUrl,
  bundlePath,
  workflow = {},
} = {}) {
  const prepared = object(preparation, "preparation");
  const resolvedBundle = path.resolve(string(bundlePath, "bundlePath"));
  const bundle = readJson(resolvedBundle, "attestation bundle");
  validateStatement(decodeBundleStatement(bundle), prepared);
  const evidence = {
    contract: GITHUB_ARTIFACT_ATTESTATION_EVIDENCE_CONTRACT,
    subject: prepared.policy.subject,
    caller: prepared.policy.caller,
    signer: prepared.policy.signer,
    build: prepared.policy.build,
    releasePassport: prepared.predicate.releasePassport,
    attestation: {
      id: string(attestationId, "attestationId"),
      url: string(attestationUrl, "attestationUrl"),
      predicateType: prepared.predicateType,
      predicateRoot: prepared.predicateRoot,
      bundle: {
        name: path.basename(resolvedBundle),
        digest: githubArtifactAttestationSha256File(resolvedBundle),
      },
    },
    workflow: {
      repository: repository(workflow.repository, "workflow.repository"),
      runId: string(workflow.runId, "workflow.runId"),
      runAttempt: string(workflow.runAttempt, "workflow.runAttempt"),
      job: string(workflow.job, "workflow.job"),
      url: string(workflow.url, "workflow.url"),
    },
    verificationPolicy: {
      repository: prepared.policy.caller.repository,
      signerWorkflow: `${prepared.policy.signer.repository}/${prepared.policy.signer.workflowPath}`,
      signerDigest: prepared.policy.signer.workflowDigest,
      sourceDigest: prepared.policy.caller.sourceSha,
      predicateType: prepared.predicateType,
      denySelfHostedRunners: true,
    },
  };
  return {
    ...evidence,
    evidenceRoot: githubArtifactAttestationSemanticRoot(evidence),
  };
}

export function createGitHubArtifactAttestationVerificationPlan({
  artifactPath,
  bundlePath,
  evidence,
} = {}) {
  const value = object(evidence, "evidence");
  if (value.contract !== GITHUB_ARTIFACT_ATTESTATION_EVIDENCE_CONTRACT) {
    throw new Error(`evidence.contract must be ${GITHUB_ARTIFACT_ATTESTATION_EVIDENCE_CONTRACT}`);
  }
  const policy = object(value.verificationPolicy, "evidence.verificationPolicy");
  return {
    command: "gh",
    args: [
      "attestation",
      "verify",
      path.resolve(string(artifactPath, "artifactPath")),
      "--repo",
      repository(policy.repository, "verificationPolicy.repository"),
      "--signer-workflow",
      string(policy.signerWorkflow, "verificationPolicy.signerWorkflow"),
      "--signer-digest",
      commit(policy.signerDigest, "verificationPolicy.signerDigest"),
      "--source-digest",
      commit(policy.sourceDigest, "verificationPolicy.sourceDigest"),
      "--predicate-type",
      string(policy.predicateType, "verificationPolicy.predicateType"),
      "--bundle",
      path.resolve(string(bundlePath, "bundlePath")),
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ],
  };
}

function verificationStatement(result) {
  return result?.verificationResult?.statement || result?.verification_result?.statement;
}

export function verifyGitHubArtifactAttestationEvidence({
  artifactPath,
  platformManifestPath,
  releasePassportPath,
  bundlePath,
  evidence,
  verificationResults,
} = {}) {
  const issues = [];
  try {
    const value = object(evidence, "evidence");
    if (value.contract !== GITHUB_ARTIFACT_ATTESTATION_EVIDENCE_CONTRACT) {
      throw new Error(`evidence.contract must be ${GITHUB_ARTIFACT_ATTESTATION_EVIDENCE_CONTRACT}`);
    }
    const preimage = structuredClone(value);
    delete preimage.evidenceRoot;
    assertEqual(
      value.evidenceRoot,
      githubArtifactAttestationSemanticRoot(preimage),
      "evidence root",
    );
    assertEqual(githubArtifactAttestationSha256File(artifactPath), value.subject.digest, "artifact digest");
    assertEqual(fs.statSync(artifactPath).size, value.subject.size, "artifact size");
    assertEqual(
      githubArtifactAttestationSha256File(platformManifestPath),
      value.build.platformManifestDigest,
      "platform manifest digest",
    );
    assertEqual(
      githubArtifactAttestationSha256File(releasePassportPath),
      value.releasePassport.digest,
      "release passport digest",
    );
    assertEqual(
      githubArtifactAttestationSha256File(bundlePath),
      value.attestation.bundle.digest,
      "attestation bundle digest",
    );
    const policy = normalizeGitHubArtifactAttestationPolicy({
      contract: GITHUB_ARTIFACT_ATTESTATION_POLICY_CONTRACT,
      predicateType: value.attestation.predicateType,
      subject: value.subject,
      caller: value.caller,
      signer: value.signer,
      build: value.build,
      permissions: REQUIRED_PERMISSIONS,
    });
    const preparation = prepareGitHubArtifactAttestation({
      subjectPath: artifactPath,
      platformManifestPath,
      releasePassportPath,
      policy,
    });
    assertEqual(preparation.predicateRoot, value.attestation.predicateRoot, "predicate root");
    const bundleStatement = decodeBundleStatement(readJson(bundlePath, "attestation bundle"));
    validateStatement(bundleStatement, preparation);
    const results = Array.isArray(verificationResults) ? verificationResults : [];
    const verified = results.some((result) => {
      try {
        validateStatement(verificationStatement(result), preparation);
        return true;
      } catch {
        return false;
      }
    });
    if (!verified) throw new Error("gh verification output has no matching verified statement");
  } catch (error) {
    issues.push({ code: "github-artifact-attestation.invalid", message: error.message });
  }
  return {
    contract: GITHUB_ARTIFACT_ATTESTATION_VERIFICATION_CONTRACT,
    ok: issues.length === 0,
    outcome: issues.length === 0 ? "verified" : "rejected",
    issues,
  };
}

export function githubArtifactAttestationRequiredPermissions() {
  return [...REQUIRED_PERMISSIONS];
}
