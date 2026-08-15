import fs from "node:fs";
import path from "node:path";
import {
  v4FloatingConsumerDocumentRoot,
  verifyV4FloatingConsumerPolicyCertification,
} from "./v4-floating-consumer-evidence.js";

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

export function requireV4ConsumerPolicyCertification({
  value,
  repository,
  sourceSha,
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
    runtimeSha: routing?.runtime?.resolvedSha || "",
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
  return {
    certification: evidence?.certification,
    certificationRoot: evidence?.certificationRoot,
    repository: passport?.product?.repository || "",
    sourceSha: passport?.release?.sourceSha || "",
    resolvedRuntimeSha: routing?.runtime?.resolvedSha || "",
    stableLockRoot: authority.contractLocks?.stable?.root || "",
    alphaLockRoot: authority.contractLocks?.alpha?.root || "",
    stableLockPath: authority.contractLocks?.stable?.path || "",
    alphaLockPath: authority.contractLocks?.alpha?.path || "",
  };
}
