import fs from "node:fs";
import path from "node:path";
import {
  v4FloatingConsumerDocumentRoot,
  verifyV4FloatingConsumerPolicyCertification,
} from "./v4-floating-consumer-evidence.js";
import { verifyV4RuntimeAuthorizationReceipt, verifyV4RuntimeResumeLineage } from "./v4-runtime-ref-resume-authority.js";
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;
export function isV4PromotionRouting(value = undefined) {
  return [
    value?.router?.ref,
    value?.shell?.ref,
    value?.runtime?.requestedRef,
  ].some((ref) => /^v4(?:-alpha)?$/u.test(String(ref || "")));
}
function resolveInside(root, relative, label) {
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(resolvedRoot, relative);
  if (!file.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes caller root: ${relative}`);
  }
  return file;
}
function resolveCallerLock(root, relative, label) {
  const file = resolveInside(root, relative, `${label} contract lock`);
  if (!fs.existsSync(file)) {
    throw new Error(`${label} contract lock is missing: ${relative}`);
  }
  return {
    path: relative,
    root: v4FloatingConsumerDocumentRoot(
      JSON.parse(fs.readFileSync(file, "utf8")),
    ),
  };
}

export function resolveV4FloatingConsumerCallerLocks(value, cwd) {
  const certification = value?.certification || value;
  const declared = certification?.authority || {};
  const stableLockPath = declared?.contractLocks?.stable?.path || "";
  const alphaLockPath = declared?.contractLocks?.alpha?.path || "";
  return {
    stableLockRoot: resolveCallerLock(cwd, stableLockPath, "stable").root,
    alphaLockRoot: resolveCallerLock(cwd, alphaLockPath, "alpha").root,
    stableLockPath,
    alphaLockPath,
  };
}

function normalizeCertification(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("v4ConsumerPolicyCertification must be a JSON object");
  }
  const certification = value.certification || value;
  const verification = verifyV4FloatingConsumerPolicyCertification({
    certification,
    certificationRoot: value.certificationRoot || "",
    expectedCertificationRoot: expected.certificationRoot,
    repository: expected.repository,
    sourceSha: expected.sourceSha,
    resolvedRuntimeSha: expected.runtimeSha,
    policyRoot: expected.policyRoot,
    scannerRoot: expected.scannerRoot,
    stableLockRoot: expected.stableLockRoot,
    alphaLockRoot: expected.alphaLockRoot,
    stableLockPath: expected.stableLockPath,
    alphaLockPath: expected.alphaLockPath,
  });
  if (!verification.ok) {
    throw new Error(
      `v4 consumer policy certification invalid: ${verification.failures.map((failure) => failure.code).join(", ")}`,
    );
  }
  return { certificationRoot: verification.certificationRoot, certification };
}
export function resolveV4ConsumerPolicyCertificationIdentity({
  release = {},
  routing = {},
  runtimeResume = undefined,
  sourceSha = "",
} = {}) {
  const certification =
    release?.certification?.certification || release?.certification;
  const certifiedSourceSha = certification?.caller?.sourceSha || "";
  const treeEquivalentSources = [
    release?.builtSourceSha || release?.built_source_sha,
    release?.promotionChannelSha || release?.promotion_channel_sha,
  ];
  const buildSha = runtimeResume?.lineage?.attempts?.build?.runtimeSha;
  const certifiedSha = certification?.invocation?.resolvedRuntimeSha || "";
  return {
    sourceSha:
      certifiedSourceSha === sourceSha ||
      (release?.treeEquivalent === true &&
        treeEquivalentSources.includes(certifiedSourceSha))
        ? certifiedSourceSha
        : sourceSha,
    runtimeSha: buildSha || certifiedSha || routing?.runtime?.resolvedSha || "",
  };
}
export function requireV4ConsumerPolicyCertification({
  value,
  repository,
  sourceSha,
  runtimeSha = "",
  routing,
  cwd,
  certificationRoot,
}) {
  const v4Routing = isV4PromotionRouting(routing);
  if (v4Routing && !value) {
    throw new Error(
      "Buildchain v4 Release Passport requires an external floating consumer policy certification",
    );
  }
  if (!value) return undefined;
  if (v4Routing && !SHA256_ROOT.test(String(certificationRoot || ""))) {
    throw new Error(
      "Buildchain v4 Release Passport requires an expected external certification root",
    );
  }
  return normalizeCertification(value, {
    repository,
    sourceSha,
    runtimeSha: runtimeSha || routing?.runtime?.resolvedSha || "",
    certificationRoot,
    ...(v4Routing ? resolveV4FloatingConsumerCallerLocks(value, cwd) : {}),
  });
}

export function releasePassportCertificationVerificationOptions({
  evidence,
  passport,
  routing,
}) {
  const authority = evidence?.certification?.authority || {};
  const identity = resolveV4ConsumerPolicyCertificationIdentity({
    release: { ...passport?.release, certification: evidence?.certification },
    routing,
    runtimeResume: passport?.v4RuntimeResume,
    sourceSha: passport?.release?.sourceSha || "",
  });
  return {
    certification: evidence?.certification,
    certificationRoot: evidence?.certificationRoot,
    repository: passport?.product?.repository || "",
    sourceSha: identity.sourceSha,
    resolvedRuntimeSha: identity.runtimeSha,
    stableLockRoot: authority.contractLocks?.stable?.root || "",
    alphaLockRoot: authority.contractLocks?.alpha?.root || "",
    stableLockPath: authority.contractLocks?.stable?.path || "",
    alphaLockPath: authority.contractLocks?.alpha?.path || "",
  };
}
function parseV4ConsumerPolicyCertification(runtime, input, cwd) {
  return runtime.parseJsonInputWithMeta(input, undefined, {
    cwd,
    label: "v4ConsumerPolicyCertificationJson",
  });
}

function normalizePromotionRouting(value = undefined) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release.promotionRouting must be a JSON object");
  }
  if (value.contract !== "buildchain.promotion-routing/v1") {
    throw new Error("release.promotionRouting contract must be buildchain.promotion-routing/v1");
  }
  for (const [label, field] of [
    ["router.ref", value.router?.ref],
    ["router.sha", value.router?.sha],
    ["shell.ref", value.shell?.ref],
    ["shell.sha", value.shell?.sha],
    ["runtime.requestedRef", value.runtime?.requestedRef],
    ["runtime.resolvedSha", value.runtime?.resolvedSha],
    ["contractLock.path", value.contractLock?.path],
    ["contractLock.digest", value.contractLock?.digest],
    ["publication.channel", value.publication?.channel],
    ["publication.targetRef", value.publication?.targetRef],
  ]) {
    if (!String(field || "").trim()) throw new Error(`release.promotionRouting.${label} is required`);
  }
  for (const [label, sha] of [
    ["router.sha", value.router.sha],
    ["shell.sha", value.shell.sha],
    ["runtime.resolvedSha", value.runtime.resolvedSha],
  ]) {
    if (!/^[0-9a-f]{40}$/i.test(String(sha))) {
      throw new Error(`release.promotionRouting.${label} must be a 40-character Git SHA`);
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(value.contractLock.digest))) {
    throw new Error("release.promotionRouting.contractLock.digest must be a sha256 digest");
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizePromotionEvidence({
  release = {},
  v4ConsumerPolicyCertification: certification,
  v4ConsumerPolicyCertificationRoot: certificationRoot,
  v4RuntimeResumeEvidence,
  repository,
  sourceSha,
  cwd,
}) {
  const routing = normalizePromotionRouting(release.promotionRouting);
  const identity = resolveV4ConsumerPolicyCertificationIdentity({
    release: { ...release, certification },
    routing,
    runtimeResume: v4RuntimeResumeEvidence,
    sourceSha,
  });
  return {
    routing,
    consumerPolicy: requireV4ConsumerPolicyCertification({
      value: certification,
      repository,
      sourceSha: identity.sourceSha,
      runtimeSha: identity.runtimeSha,
      routing,
      cwd,
      certificationRoot,
    }),
  };
}

function normalizeV4RuntimeResumeEvidence(value, expected = {}) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("v4RuntimeResumeEvidence must be a JSON object");
  }
  const authorizationVerification = verifyV4RuntimeAuthorizationReceipt({
    receipt: value.authorization,
    receiptRoot: value.authorizationRoot,
    repository: expected.repository,
    sourceSha: expected.sourceSha,
    runtimeSha: expected.resumeRuntimeSha,
    consumerPolicyReceiptRoot: expected.consumerPolicyReceiptRoot,
  });
  if (!authorizationVerification.ok) {
    throw new Error(`v4 runtime authorization invalid: ${authorizationVerification.failures.join(", ")}`);
  }
  const lineageVerification = verifyV4RuntimeResumeLineage({
    lineage: value.lineage,
    lineageRoot: value.lineageRoot,
    repository: expected.repository,
    sourceSha: expected.sourceSha,
    resumeRuntimeSha: expected.resumeRuntimeSha,
    consumerPolicyReceiptRoot: expected.consumerPolicyReceiptRoot,
  });
  if (!lineageVerification.ok) {
    throw new Error(`v4 runtime resume lineage invalid: ${lineageVerification.failures.join(", ")}`);
  }
  if (value.lineage?.authorizationRoot !== value.authorizationRoot) {
    throw new Error("v4 runtime resume lineage authorization root mismatch");
  }
  return {
    authorizationRoot: value.authorizationRoot,
    authorization: structuredClone(value.authorization),
    lineageRoot: value.lineageRoot,
    lineage: structuredClone(value.lineage),
  };
}

function v4RuntimeResumeSourceSha(runtime, release, fallback = "") {
  const builtSourceSha = runtime.releaseField(
    release || {},
    "builtSourceSha",
    "built_source_sha",
  );
  return release?.treeEquivalent === true && builtSourceSha
    ? builtSourceSha
    : fallback;
}


function validateV4ConsumerPolicyPassportSection(runtime, { passport, issues }) {
  const routing = passport?.promotionRouting;
  const evidence = passport?.v4ConsumerPolicy;
  if (isV4PromotionRouting(routing) && !evidence) {
    issues.push(runtime.issue(
      "error",
      "v4ConsumerPolicy.missing",
      "Buildchain v4 Release Passport requires an external floating consumer policy certification",
    ));
    return;
  }
  if (!evidence) return;
  const verification = verifyV4FloatingConsumerPolicyCertification(
    releasePassportCertificationVerificationOptions({
      evidence,
      passport,
      routing,
    }),
  );
  for (const failure of verification.failures) {
    issues.push(runtime.issue("error", `v4ConsumerPolicy.${failure.code}`, failure.message));
  }
}

function validateV4RuntimeResumePassportSection(runtime, { passport, issues }) {
  const evidence = passport?.v4RuntimeResume;
  if (!evidence) return;
  const consumerPolicyReceiptRoot = passport?.v4ConsumerPolicy?.certification?.receiptRoot || "";
  const authorization = verifyV4RuntimeAuthorizationReceipt({
    receipt: evidence.authorization,
    receiptRoot: evidence.authorizationRoot,
    repository: passport?.product?.repository || "",
    sourceSha: v4RuntimeResumeSourceSha(runtime, passport?.release, passport?.release?.sourceSha || ""),
    runtimeSha: passport?.promotionRouting?.runtime?.resolvedSha || "",
    consumerPolicyReceiptRoot,
  });
  for (const failure of authorization.failures) {
    issues.push(runtime.issue("error", `v4RuntimeResume.authorization.${failure}`, failure));
  }
  const lineage = verifyV4RuntimeResumeLineage({
    lineage: evidence.lineage,
    lineageRoot: evidence.lineageRoot,
    repository: passport?.product?.repository || "",
    sourceSha: v4RuntimeResumeSourceSha(runtime, passport?.release, passport?.release?.sourceSha || ""),
    resumeRuntimeSha: passport?.promotionRouting?.runtime?.resolvedSha || "",
    consumerPolicyReceiptRoot,
  });
  for (const failure of lineage.failures) {
    issues.push(runtime.issue("error", `v4RuntimeResume.lineage.${failure}`, failure));
  }
  if (evidence.lineage?.authorizationRoot !== evidence.authorizationRoot) {
    issues.push(runtime.issue(
      "error",
      "v4RuntimeResume.authorization-root-mismatch",
      "runtime resume lineage must bind the embedded authorization receipt root",
    ));
  }
}
export function createV4ReleasePassportOperations(runtime) {
  return {
    normalizePromotionEvidence,
    normalizePromotionRouting,
    normalizeV4RuntimeResumeEvidence,
    parseV4ConsumerPolicyCertification: (input, cwd) => parseV4ConsumerPolicyCertification(runtime, input, cwd),
    v4RuntimeResumeSourceSha: (release, fallback) => v4RuntimeResumeSourceSha(runtime, release, fallback),
    validateV4ConsumerPolicyPassportSection: (options) =>
      validateV4ConsumerPolicyPassportSection(runtime, options),
    validateV4RuntimeResumePassportSection: (options) =>
      validateV4RuntimeResumePassportSection(runtime, options),
  };
}
