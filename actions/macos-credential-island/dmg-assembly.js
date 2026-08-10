import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DMG_ASSEMBLY_CONTRACT =
  "buildchain.macos-dmg-assembly-evidence/v1";
export const DMG_RESOURCE_BUSY_FAILURE =
  "hdiutil failed with status 1: hdiutil: create failed - Resource busy";
export const DMG_RETRY_DELAYS_MS = Object.freeze([2000, 5000]);

const SHA1_PATTERN = /^[0-9a-f]{40}$/iu;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/iu;
const EXECUTION_COMPONENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;

function requiredPattern(value, pattern, label) {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized.toLowerCase();
}

function safeVolumeStem(value) {
  const stem = String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 12);
  if (!stem || stem === "." || stem === "..") {
    throw new Error("DMG volume name resolves to an unsafe value");
  }
  return stem;
}

function assertOwnedChild(root, target, label) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the owned temporary root`);
  }
  return absoluteTarget;
}

function removeOwnedAttempt(root, target) {
  const owned = assertOwnedChild(root, target, "DMG attempt artifact");
  if (!fs.existsSync(owned)) return true;
  if (!fs.lstatSync(owned).isFile()) {
    throw new Error("DMG attempt artifact is not a regular file");
  }
  fs.rmSync(owned, { force: true });
  return !fs.existsSync(owned);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function classifyHdiutilCreateFailure(error) {
  const message = String(error?.message || error || "").trim();
  return {
    code: message === DMG_RESOURCE_BUSY_FAILURE ? "resource-busy" : "terminal",
    retryable: message === DMG_RESOURCE_BUSY_FAILURE,
  };
}

export function createDmgAssemblyIdentity({
  sourceSha,
  runtimeSha,
  requestDigest,
  unsignedArchiveDigest,
  runId,
  runAttempt,
  executionNonce = crypto.randomUUID(),
}) {
  const binding = {
    sourceSha: requiredPattern(sourceSha, SHA1_PATTERN, "source SHA"),
    runtimeSha: requiredPattern(runtimeSha, SHA1_PATTERN, "runtime SHA"),
    requestDigest: requiredPattern(
      requestDigest,
      SHA256_PATTERN,
      "signing request digest",
    ),
    unsignedArchiveDigest: requiredPattern(
      unsignedArchiveDigest,
      SHA256_PATTERN,
      "unsigned archive digest",
    ),
    runId: requiredPattern(
      runId,
      EXECUTION_COMPONENT_PATTERN,
      "execution run id",
    ),
    runAttempt: requiredPattern(
      runAttempt,
      EXECUTION_COMPONENT_PATTERN,
      "execution run attempt",
    ),
    executionNonce: requiredPattern(
      executionNonce,
      EXECUTION_COMPONENT_PATTERN,
      "execution nonce",
    ),
  };
  const id = crypto
    .createHash("sha256")
    .update(JSON.stringify(binding))
    .digest("hex");
  return { id, binding };
}

export function assembleDmgWithRetry({
  temporaryRoot,
  sourceRoot,
  productName,
  identity,
  runHdiutil,
  sleep = sleepSync,
}) {
  if (typeof runHdiutil !== "function") {
    throw new Error("DMG assembly requires an hdiutil runner");
  }
  const ownedRoot = path.resolve(temporaryRoot);
  if (!fs.statSync(ownedRoot).isDirectory()) {
    throw new Error("DMG assembly temporary root is not a directory");
  }
  const ownedSource = assertOwnedChild(
    ownedRoot,
    sourceRoot,
    "DMG source root",
  );
  if (!fs.statSync(ownedSource).isDirectory()) {
    throw new Error("DMG source root is not a directory");
  }
  const volumeStem = safeVolumeStem(productName);
  const assemblyRoot = path.join(ownedRoot, `dmg-assembly-${identity.id}`);
  fs.mkdirSync(assemblyRoot);
  const attempts = [];

  for (let index = 0; index <= DMG_RETRY_DELAYS_MS.length; index += 1) {
    const number = index + 1;
    const imageName = `attempt-${number}.dmg`;
    const imagePath = path.join(assemblyRoot, imageName);
    const volumeName = `${volumeStem}-${identity.id.slice(0, 8)}-${number}`;
    try {
      runHdiutil(
        "/usr/bin/hdiutil",
        [
          "create",
          "-volname",
          volumeName,
          "-srcfolder",
          ownedSource,
          "-format",
          "UDZO",
          imagePath,
        ],
        { failureLabel: "hdiutil" },
      );
      if (!fs.statSync(imagePath).isFile()) {
        throw new Error("hdiutil did not create a regular DMG artifact");
      }
      attempts.push({
        number,
        outcome: "created",
        classification: "none",
        imageName,
        volumeName,
      });
      return {
        imagePath,
        assemblyRoot,
        evidence: {
          schema: DMG_ASSEMBLY_CONTRACT,
          status: "created",
          executionId: identity.id,
          binding: identity.binding,
          policy: {
            maxAttempts: DMG_RETRY_DELAYS_MS.length + 1,
            retryableClassifications: ["resource-busy"],
            retryDelaysMs: [...DMG_RETRY_DELAYS_MS],
          },
          attempts,
          cleanup: {
            ownership: "temporary-root-only",
            failedAttemptArtifactsRemoved: true,
            finalOwnedRoot: "pending",
          },
        },
      };
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error(String(error || ""));
      const classification = classifyHdiutilCreateFailure(failure);
      const removed = removeOwnedAttempt(ownedRoot, imagePath);
      attempts.push({
        number,
        outcome: "failed",
        classification: classification.code,
        imageName,
        volumeName,
        ownedArtifactRemoved: removed,
      });
      if (!classification.retryable || index === DMG_RETRY_DELAYS_MS.length) {
        failure.dmgAssembly = {
          schema: DMG_ASSEMBLY_CONTRACT,
          status: "failed",
          executionId: identity.id,
          attempts,
        };
        throw failure;
      }
      sleep(DMG_RETRY_DELAYS_MS[index]);
    }
  }
  throw new Error("DMG assembly exhausted without a terminal result");
}

function signAndVerifyDmg(
  filePath,
  { certificateSha1, keychainPath, expectedTeamId, runFile },
) {
  runFile("/usr/bin/codesign", [
    "--force",
    "--sign",
    certificateSha1,
    "--keychain",
    keychainPath,
    "--timestamp",
    filePath,
  ]);
  runFile("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    filePath,
  ]);
  const detail = runFile("/usr/bin/codesign", ["-d", "--verbose=4", filePath]);
  if (!detail.includes("Authority=Developer ID Application:")) {
    throw new Error(
      "signed container does not expose a Developer ID Application authority",
    );
  }
  if (!/^Timestamp=.+$/imu.test(detail)) {
    throw new Error("signed container does not expose a secure timestamp");
  }
  const teamMatch = detail.match(/TeamIdentifier=([A-Z0-9]{10})/u);
  if (!teamMatch || teamMatch[1] !== expectedTeamId) {
    throw new Error("signed container team identifier mismatch");
  }
}

function captureToolchain(runFile) {
  return {
    node: process.version,
    macosProductVersion: runFile("/usr/bin/sw_vers", ["-productVersion"], {
      stdoutOnly: true,
    }).trim(),
    macosBuildVersion: runFile("/usr/bin/sw_vers", ["-buildVersion"], {
      stdoutOnly: true,
    }).trim(),
    xcode: runFile("/usr/bin/xcodebuild", ["-version"], {
      stdoutOnly: true,
    })
      .trim()
      .replace(/\r?\n/gu, "; "),
  };
}

export function createSignedDmg({
  temporaryRoot,
  sourceRoot,
  productName,
  destinationPath,
  binding,
  certificateSha1,
  keychainPath,
  expectedTeamId,
  notaryCredentials,
  runFile,
  submitNotary,
  staple,
}) {
  const identity = createDmgAssemblyIdentity(binding);
  const assembly = assembleDmgWithRetry({
    temporaryRoot,
    sourceRoot,
    productName,
    identity,
    runHdiutil: runFile,
  });
  signAndVerifyDmg(assembly.imagePath, {
    certificateSha1,
    keychainPath,
    expectedTeamId,
    runFile,
  });
  const notarization = submitNotary(
    assembly.imagePath,
    notaryCredentials,
    "disk image",
  );
  staple(assembly.imagePath);
  runFile("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=2",
    assembly.imagePath,
  ]);
  fs.copyFileSync(
    assembly.imagePath,
    destinationPath,
    fs.constants.COPYFILE_EXCL,
  );
  return {
    evidence: assembly.evidence,
    executionId: identity.id,
    notarization,
    toolchain: captureToolchain(runFile),
  };
}

export function createRunBoundDmg({
  temporaryRoot,
  sourceRoot,
  destinationPath,
  sealed,
  sourceSha,
  runtimeSha,
  certificate,
  notaryCredentials,
  runFile,
  submitNotary,
  staple,
}) {
  const execution = {
    runId: String(process.env.GITHUB_RUN_ID || "local"),
    runAttempt: String(process.env.GITHUB_RUN_ATTEMPT || "1"),
  };
  const requestDigest =
    sealed.request?.digest || sha256File(sealed.manifestPath);
  const signedDmg = createSignedDmg({
    temporaryRoot,
    sourceRoot,
    productName: sealed.manifest.app.productName,
    destinationPath,
    binding: {
      sourceSha,
      runtimeSha,
      requestDigest,
      unsignedArchiveDigest: sealed.manifest.archive.sha256,
      ...execution,
    },
    ...certificate,
    notaryCredentials,
    runFile,
    submitNotary,
    staple,
  });
  return { execution, requestDigest, signedDmg };
}

function acceptedAssemblyBinding(binding, request, expectedExecution) {
  return (
    binding?.sourceSha === request.source.sha &&
    binding?.runtimeSha === request.runtime.sha &&
    binding?.requestDigest === request.digest &&
    binding?.unsignedArchiveDigest === request.artifact.transport.digest &&
    binding?.runId === expectedExecution.runId &&
    binding?.runAttempt === expectedExecution.runAttempt
  );
}

function acceptedRetryPolicy(policy) {
  return (
    policy?.maxAttempts === 3 &&
    JSON.stringify(policy?.retryableClassifications) === '["resource-busy"]' &&
    JSON.stringify(policy?.retryDelaysMs) === "[2000,5000]"
  );
}

function acceptedAttempts(attempts, maxAttempts) {
  return (
    Array.isArray(attempts) &&
    attempts.length >= 1 &&
    attempts.length <= maxAttempts &&
    attempts.at(-1)?.outcome === "created" &&
    attempts
      .slice(0, -1)
      .every(
        (attempt) =>
          attempt.outcome === "failed" &&
          attempt.classification === "resource-busy" &&
          attempt.ownedArtifactRemoved === true,
      )
  );
}

function acceptedAssembly(evidence, request, expectedExecution) {
  const assembly = evidence?.dmgAssembly;
  return (
    assembly?.schema === DMG_ASSEMBLY_CONTRACT &&
    assembly?.status === "accepted" &&
    /^[0-9a-f]{64}$/u.test(String(assembly?.executionId || "")) &&
    assembly.executionId === evidence.execution?.id &&
    acceptedAssemblyBinding(assembly.binding, request, expectedExecution) &&
    acceptedRetryPolicy(assembly.policy) &&
    acceptedAttempts(assembly.attempts, assembly.policy.maxAttempts) &&
    assembly.cleanup?.ownership === "temporary-root-only" &&
    assembly.cleanup?.failedAttemptArtifactsRemoved === true &&
    assembly.cleanup?.finalOwnedRoot === "removed"
  );
}

export function acceptedMacosCredentialEvidence(
  evidence,
  request,
  expectedExecution,
) {
  return (
    acceptedAssembly(evidence, request, expectedExecution) &&
    evidence.schema === "buildchain.macos-credential-island-evidence/v1" &&
    evidence.status === "accepted" &&
    evidence.source?.repository === request.source.repository &&
    evidence.source?.sha === request.source.sha &&
    evidence.source?.treeSha === request.source.treeSha &&
    evidence.buildchain?.runtimeSha === request.runtime.sha &&
    evidence.input?.requestDigest === request.digest &&
    evidence.app?.architecture === request.artifact.arch &&
    evidence.execution?.runId === expectedExecution.runId &&
    evidence.execution?.runAttempt === expectedExecution.runAttempt &&
    evidence.cleanup?.status === "complete" &&
    Boolean(evidence.toolchain?.node) &&
    Boolean(evidence.toolchain?.macosProductVersion) &&
    Boolean(evidence.toolchain?.macosBuildVersion) &&
    Boolean(evidence.toolchain?.xcode) &&
    evidence.notarization?.application?.status === "Accepted" &&
    evidence.notarization?.diskImage?.status === "Accepted"
  );
}
