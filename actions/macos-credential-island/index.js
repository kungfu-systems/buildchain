import * as core from "@actions/core";
import { signAsync } from "@electron/osx-sign/dist/cjs/index.js";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  API_ISSUER_PATTERN,
  API_KEY_ID_PATTERN,
  EVIDENCE_CONTRACT,
  TEAM_ID_PATTERN,
  assertContainedSymlinks,
  assertRealPathInside,
  cleanupState,
  createCredentialArtifactManifest,
  decodeBase64Secret,
  entitlementsForProfile,
  findEmbeddedWheels,
  inspectExtractedWheel,
  loadMacosSigningInput,
  parseIdentityListing,
  parseNotarySubmission,
  requirePattern,
  requireRepository,
  requireSha,
  resolveExpectedBundleId,
  rewriteWheelRecord,
  resolveInside,
  safeArtifactName,
  safeArtifactStem,
  safePlatformId,
  sha256File,
  signingIgnore,
  signingOptionsForFile,
  summarizeNotaryLog,
  validateWheelEntryListing,
  validateWheelMetadata,
} from "./lib.js";
import { createRunBoundDmg } from "./dmg-assembly.js";

const COMPLETE_CLEANUP_EVIDENCE = Object.freeze({
  status: "complete",
  ownership: "credential-island-resources-only",
});

function input(name, required = true) {
  return core.getInput(name, { required }).trim();
}

function runFile(
  command,
  args,
  { cwd, env, redact = false, stdoutOnly = false, failureLabel = "" } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env: env || process.env,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = redact
      ? "sensitive command output withheld"
      : `${result.stderr || result.stdout || result.error?.message || ""}`
          .trim()
          .slice(0, 2000);
    throw (
      result.error ||
      new Error(
        `${failureLabel || path.basename(command)} failed with status ${result.status}: ${detail}`,
      )
    );
  }
  return stdoutOnly
    ? `${result.stdout || ""}`
    : `${result.stdout || ""}${result.stderr || ""}`;
}

function runSecurity(args, options = {}) {
  return runFile("/usr/bin/security", args, options);
}

function parseKeychainList(output) {
  return String(output || "")
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

function plistValue(appPath, key) {
  const info = path.join(appPath, "Contents", "Info.plist");
  return runFile("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    info,
  ]).trim();
}

function writePrivate(filePath, bytes) {
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function writeCleanupState(filePath, state) {
  fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function verifySignedApp(appPath, expectedTeamId) {
  runFile("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  const detail = runFile("/usr/bin/codesign", ["-d", "--verbose=4", appPath]);
  if (!detail.includes("Authority=Developer ID Application:")) {
    throw new Error(
      "signed app does not expose a Developer ID Application authority",
    );
  }
  if (!/flags=.*runtime/iu.test(detail)) {
    throw new Error("signed app does not enable hardened runtime");
  }
  const teamMatch = detail.match(/TeamIdentifier=([A-Z0-9]{10})/u);
  if (!teamMatch || teamMatch[1] !== expectedTeamId) {
    throw new Error("signed app team identifier mismatch");
  }
  return { teamId: teamMatch[1] };
}

function verifySignedMachO(filePath, expectedTeamId) {
  runFile("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    filePath,
  ]);
  const detail = runFile("/usr/bin/codesign", ["-d", "--verbose=4", filePath]);
  if (!detail.includes("Authority=Developer ID Application:")) {
    throw new Error(
      "embedded wheel Mach-O does not expose a Developer ID Application authority",
    );
  }
  if (!/flags=.*runtime/iu.test(detail)) {
    throw new Error("embedded wheel Mach-O does not enable hardened runtime");
  }
  if (!/^Timestamp=.+$/imu.test(detail)) {
    throw new Error("embedded wheel Mach-O does not expose a secure timestamp");
  }
  const teamMatch = detail.match(/TeamIdentifier=([A-Z0-9]{10})/u);
  if (!teamMatch || teamMatch[1] !== expectedTeamId) {
    throw new Error("embedded wheel Mach-O team identifier mismatch");
  }
}

function sealEmbeddedWheelCode(
  appPath,
  temporaryRoot,
  { certificateSha1, keychainPath, expectedTeamId },
) {
  const wheels = findEmbeddedWheels(appPath);
  let signedFileCount = 0;
  wheels.forEach((wheelPath, wheelIndex) => {
    const listing = runFile("/usr/bin/unzip", ["-Z1", wheelPath], {
      stdoutOnly: true,
      failureLabel: "list embedded wheel",
    });
    const entries = validateWheelEntryListing(listing);
    const metadata = runFile("/usr/bin/unzip", ["-Z", "-l", wheelPath], {
      stdoutOnly: true,
      failureLabel: "inspect embedded wheel metadata",
    });
    validateWheelMetadata(metadata, entries.length);
    const wheelRoot = path.join(temporaryRoot, `wheel-${wheelIndex}`);
    fs.mkdirSync(wheelRoot);
    runFile("/usr/bin/ditto", ["-x", "-k", wheelPath, wheelRoot], {
      failureLabel: "extract embedded wheel",
    });
    const inspected = inspectExtractedWheel(wheelRoot);
    if (inspected.machOFiles.length === 0) return;

    for (const filePath of inspected.machOFiles) {
      runFile("/usr/bin/codesign", [
        "--force",
        "--sign",
        certificateSha1,
        "--keychain",
        keychainPath,
        "--options",
        "runtime",
        "--timestamp",
        filePath,
      ]);
      verifySignedMachO(filePath, expectedTeamId);
      signedFileCount += 1;
    }
    rewriteWheelRecord(wheelRoot);
    const repackedPath = path.join(temporaryRoot, `wheel-${wheelIndex}.whl`);
    runFile("/usr/bin/ditto", [
      "-c",
      "-k",
      "--norsrc",
      wheelRoot,
      repackedPath,
    ]);
    runFile("/usr/bin/unzip", ["-t", repackedPath], {
      failureLabel: "verify repacked embedded wheel",
    });
    const originalMode = fs.statSync(wheelPath).mode;
    fs.renameSync(repackedPath, wheelPath);
    fs.chmodSync(wheelPath, originalMode);
  });
  return { wheelCount: wheels.length, signedFileCount };
}

function submitNotary(target, credentials, label) {
  const output = runFile(
    "/usr/bin/xcrun",
    [
      "notarytool",
      "submit",
      target,
      "--key",
      credentials.keyPath,
      "--key-id",
      credentials.keyId,
      "--issuer",
      credentials.issuer,
      "--wait",
      "--output-format",
      "json",
    ],
    { redact: true, stdoutOnly: true },
  );
  const submission = parseNotarySubmission(output, label);
  if (submission.status === "Accepted") return submission;

  let diagnostics = {
    status: submission.status,
    statusCode: "",
    statusSummary: "sanitized notarization log unavailable",
    issues: [],
  };
  try {
    const log = runFile(
      "/usr/bin/xcrun",
      [
        "notarytool",
        "log",
        submission.id,
        "--key",
        credentials.keyPath,
        "--key-id",
        credentials.keyId,
        "--issuer",
        credentials.issuer,
        "--output-format",
        "json",
      ],
      { redact: true, stdoutOnly: true },
    );
    const summary = summarizeNotaryLog(log, label);
    diagnostics = {
      ...summary,
      status: summary.status || submission.status,
    };
  } catch {
    // The submission identity and status remain useful without exposing command output.
  }
  throw new Error(
    `${label} notarization was not accepted: ${JSON.stringify({
      submissionId: submission.id,
      ...diagnostics,
    }).slice(0, 4000)}`,
  );
}

function staple(target) {
  runFile("/usr/bin/xcrun", ["stapler", "staple", target]);
  runFile("/usr/bin/xcrun", ["stapler", "validate", target]);
}

function fileEvidence(kind, filePath) {
  return {
    kind,
    name: path.basename(filePath),
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
  };
}

function completeCredentialCleanup(state, cleanupStatePath) {
  const errors = cleanupState(state, (args) => runSecurity(args));
  if (errors.length > 0) {
    throw new Error(`credential cleanup failed: ${errors.join("; ")}`);
  }
  writeCleanupState(cleanupStatePath, { completed: true });
  return true;
}

async function main() {
  if (process.platform !== "darwin")
    throw new Error("macOS credential island requires a macOS runner");
  const startedAt = new Date().toISOString();
  const sourceRepository = requireRepository(input("source-repository"));
  const sourceSha = requireSha(input("source-sha"), "source-sha");
  const sourceTreeSha = requireSha(input("source-tree-sha"), "source-tree-sha");
  const runtimeSha = requireSha(
    input("buildchain-runtime-sha"),
    "buildchain-runtime-sha",
  );
  const sourceRef = input("source-ref", false);
  const artifactName = safeArtifactName(input("artifact-name"));
  const configuredBundleId = input("expected-bundle-id", false);
  const expectedTeamId = requirePattern(
    input("expected-team-id"),
    TEAM_ID_PATTERN,
    "expected-team-id",
  );
  const certificateSha1 = requireSha(
    input("certificate-sha1"),
    "certificate-sha1",
  );
  const apiKeyId = requirePattern(
    input("notary-api-key-id"),
    API_KEY_ID_PATTERN,
    "notary-api-key-id",
  );
  const apiIssuer = requirePattern(
    input("notary-api-issuer"),
    API_ISSUER_PATTERN,
    "notary-api-issuer",
  );
  const p12Base64 = input("certificate-p12-base64");
  const p12Password = input("certificate-password");
  const p8Base64 = input("notary-api-key-p8-base64");
  for (const secret of [p12Base64, p12Password, p8Base64])
    core.setSecret(secret);
  delete process.env.INPUT_CERTIFICATE_P12_BASE64;
  delete process.env.INPUT_CERTIFICATE_PASSWORD;
  delete process.env.INPUT_NOTARY_API_KEY_P8_BASE64;

  const inputRoot = path.resolve(input("input-root"));
  const outputRoot = path.resolve(input("output-root"));
  const entitlements = entitlementsForProfile(
    input("entitlements-profile", false) || "electron-desktop-v1",
  );
  const sealed = loadMacosSigningInput(inputRoot, {
    repository: sourceRepository,
    sourceSha,
    sourceTreeSha,
    runtimeSha,
    platformId: input("platform-id", false),
    artifactId: input("artifact-id", false),
  });
  const declaredBundleId =
    String(sealed.manifest.app.bundleId || "").trim() || configuredBundleId;
  const artifactStem = safeArtifactStem(
    input("artifact-stem", false) || sealed.manifest.app.productName,
  );
  const platformId = safePlatformId(
    input("platform-id", false) || `${sealed.manifest.platform.id}-credential`,
  );
  const signedOutputRoot = resolveInside(
    outputRoot,
    input("artifact-relative-output", false) || "product/release",
    "artifact-relative-output",
  );
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(signedOutputRoot, { recursive: true });

  const runnerTemp = path.resolve(process.env.RUNNER_TEMP || os.tmpdir());
  const temporaryRoot = fs.mkdtempSync(
    path.join(runnerTemp, "buildchain-macos-credential-island-"),
  );
  const cleanupStatePath = path.join(
    runnerTemp,
    `buildchain-macos-credential-island-cleanup-${process.env.GITHUB_RUN_ID || "local"}-${crypto.randomUUID()}.json`,
  );
  const state = { temporaryRoot, temporaryKeychain: "", originalKeychains: [] };
  let cleanupCompleted = false;
  writeCleanupState(cleanupStatePath, state);
  core.saveState("cleanup-state-path", cleanupStatePath);

  try {
    const extractedRoot = path.join(temporaryRoot, "extracted");
    fs.mkdirSync(extractedRoot);
    runFile("/usr/bin/ditto", ["-x", "-k", sealed.archivePath, extractedRoot]);
    const appPath = resolveInside(
      extractedRoot,
      sealed.manifest.app.archivePath,
      "sealed app archive path",
    );
    if (!fs.statSync(appPath).isDirectory() || !appPath.endsWith(".app")) {
      throw new Error("sealed app archive path is not an application bundle");
    }
    assertRealPathInside(extractedRoot, appPath, "sealed app archive path");
    const topLevel = fs.readdirSync(extractedRoot);
    if (
      topLevel.length !== 1 ||
      path.resolve(extractedRoot, topLevel[0]) !== appPath
    ) {
      throw new Error("sealed archive must contain exactly one top-level app");
    }
    assertContainedSymlinks(appPath);
    const expectedBundleId = resolveExpectedBundleId(
      declaredBundleId,
      plistValue(appPath, "CFBundleIdentifier"),
    );
    const productVersion = plistValue(appPath, "CFBundleShortVersionString");
    const artifactVersion = safeArtifactStem(productVersion);

    const p12Path = path.join(temporaryRoot, "developer-id.p12");
    const apiKeyPath = path.join(temporaryRoot, `AuthKey_${apiKeyId}.p8`);
    const entitlementsPath = path.join(temporaryRoot, "entitlements.plist");
    writePrivate(
      p12Path,
      decodeBase64Secret(p12Base64, "certificate-p12-base64", {
        minBytes: 256,
      }),
    );
    writePrivate(
      apiKeyPath,
      decodeBase64Secret(p8Base64, "notary-api-key-p8-base64", {
        minBytes: 128,
      }),
    );
    writePrivate(entitlementsPath, Buffer.from(entitlements.content));

    const keychainPath = path.join(temporaryRoot, "signing.keychain-db");
    const keychainPassword = crypto.randomBytes(32).toString("base64url");
    core.setSecret(keychainPassword);
    state.originalKeychains = parseKeychainList(
      runSecurity(["list-keychains", "-d", "user"]),
    );
    state.temporaryKeychain = keychainPath;
    writeCleanupState(cleanupStatePath, state);
    runSecurity(["create-keychain", "-p", keychainPassword, keychainPath], {
      redact: true,
      failureLabel: "create temporary keychain",
    });
    runSecurity(["set-keychain-settings", "-lut", "21600", keychainPath]);
    runSecurity(["unlock-keychain", "-p", keychainPassword, keychainPath], {
      redact: true,
      failureLabel: "unlock temporary keychain",
    });
    runSecurity(
      [
        "import",
        p12Path,
        "-k",
        keychainPath,
        "-P",
        p12Password,
        "-T",
        "/usr/bin/codesign",
        "-T",
        "/usr/bin/security",
      ],
      {
        redact: true,
        failureLabel: "import Developer ID PKCS#12",
      },
    );
    runSecurity(
      [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        keychainPassword,
        keychainPath,
      ],
      {
        redact: true,
        failureLabel: "configure Developer ID key access",
      },
    );
    runSecurity([
      "list-keychains",
      "-d",
      "user",
      "-s",
      keychainPath,
      ...state.originalKeychains,
    ]);
    const identity = parseIdentityListing(
      runSecurity(["find-identity", "-v", "-p", "codesigning", keychainPath]),
      certificateSha1,
    );

    const embeddedWheelCode = sealEmbeddedWheelCode(appPath, temporaryRoot, {
      certificateSha1,
      keychainPath,
      expectedTeamId,
    });
    core.info(
      `sealed ${embeddedWheelCode.signedFileCount} Mach-O files across ${embeddedWheelCode.wheelCount} embedded wheels`,
    );
    await signAsync({
      app: appPath,
      identity: certificateSha1,
      identityValidation: false,
      keychain: keychainPath,
      hardenedRuntime: true,
      entitlements: entitlementsPath,
      entitlementsInherit: entitlementsPath,
      optionsForFile: signingOptionsForFile(entitlementsPath),
      gatekeeperAssess: false,
      ignore: signingIgnore,
    });
    verifySignedApp(appPath, expectedTeamId);

    const appSubmissionZip = path.join(
      temporaryRoot,
      "app-notary-submission.zip",
    );
    runFile("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      appPath,
      appSubmissionZip,
    ]);
    const appNotary = submitNotary(
      appSubmissionZip,
      { keyPath: apiKeyPath, keyId: apiKeyId, issuer: apiIssuer },
      "application",
    );
    staple(appPath);
    runFile("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=2",
      appPath,
    ]);

    const outputBase = `${artifactStem}-${artifactVersion}-macos-${sealed.manifest.platform.arch}`;
    const zipPath = path.join(signedOutputRoot, `${outputBase}.zip`);
    const dmgPath = path.join(signedOutputRoot, `${outputBase}.dmg`);
    runFile("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      appPath,
      zipPath,
    ]);
    const dmgRoot = path.join(temporaryRoot, "dmg-root");
    fs.mkdirSync(dmgRoot);
    runFile("/usr/bin/ditto", [
      appPath,
      path.join(dmgRoot, path.basename(appPath)),
    ]);
    const { execution, requestDigest, signedDmg } = createRunBoundDmg({
      temporaryRoot,
      sourceRoot: dmgRoot,
      destinationPath: dmgPath,
      sealed,
      sourceSha,
      runtimeSha,
      certificate: { certificateSha1, keychainPath, expectedTeamId },
      notaryCredentials: {
        keyPath: apiKeyPath,
        keyId: apiKeyId,
        issuer: apiIssuer,
      },
      runFile,
      submitNotary,
      staple,
    });
    cleanupCompleted = completeCredentialCleanup(state, cleanupStatePath);
    signedDmg.evidence.status = "accepted";
    signedDmg.evidence.cleanup.finalOwnedRoot = "removed";

    const artifacts = [
      fileEvidence("zip", zipPath),
      fileEvidence("dmg", dmgPath),
    ];
    const evidence = {
      schema: EVIDENCE_CONTRACT,
      status: "accepted",
      startedAt,
      completedAt: new Date().toISOString(),
      source: {
        repository: sourceRepository,
        sha: sourceSha,
        treeSha: sourceTreeSha,
      },
      buildchain: { runtimeSha },
      input: {
        requestDigest,
        manifestSha256: sha256File(sealed.manifestPath),
        archiveSha256: sealed.manifest.archive.sha256,
        archiveBytes: sealed.manifest.archive.bytes,
      },
      app: {
        bundleId: expectedBundleId,
        productName: sealed.manifest.app.productName,
        version: productVersion,
        architecture: sealed.manifest.platform.arch,
      },
      identity: {
        certificateSha1,
        certificateSubject: identity.subject,
        teamId: expectedTeamId,
        entitlementsProfile: entitlements.name,
        entitlementsSha256: entitlements.sha256,
      },
      notarization: {
        application: appNotary,
        diskImage: signedDmg.notarization,
      },
      execution: {
        id: signedDmg.executionId,
        ...execution,
      },
      dmgAssembly: signedDmg.evidence,
      cleanup: COMPLETE_CLEANUP_EVIDENCE,
      toolchain: signedDmg.toolchain,
      verification: {
        codesignStrict: true,
        hardenedRuntime: true,
        embeddedWheelCount: embeddedWheelCode.wheelCount,
        embeddedWheelMachOCount: embeddedWheelCode.signedFileCount,
        appStaple: true,
        appGatekeeper: true,
        dmgCodesign: true,
        dmgStaple: true,
        dmgGatekeeper: true,
      },
      artifacts,
      runner: {
        os: process.platform,
        arch: process.arch,
        image: process.env.ImageOS || "",
      },
    };
    const evidencePath = path.join(
      signedOutputRoot,
      "credential-island-evidence.json",
    );
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const manifest = createCredentialArtifactManifest({
      artifactName,
      platform: {
        id: platformId,
        name: `${sealed.manifest.platform.id} credential island`,
        arch: sealed.manifest.platform.arch,
      },
      repository: sourceRepository,
      sourceSha,
      sourceRef,
      artifactRoot: outputRoot,
      files: [dmgPath, evidencePath, zipPath],
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    if (!manifest.expectedArtifacts.ok) {
      throw new Error("credential artifact manifest did not qualify");
    }
    const manifestPath = path.join(outputRoot, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    core.setOutput("evidence-path", evidencePath);
    core.setOutput("manifest-path", manifestPath);
    core.setOutput("artifact-root", outputRoot);
    core.setOutput("dmg-path", dmgPath);
    core.setOutput("zip-path", zipPath);
    core.setOutput(
      "dmg-sha256",
      artifacts.find((item) => item.kind === "dmg").sha256,
    );
    core.setOutput(
      "zip-sha256",
      artifacts.find((item) => item.kind === "zip").sha256,
    );
    core.info(
      `macOS credential island accepted ${expectedBundleId} at source ${sourceSha}`,
    );
  } finally {
    if (!cleanupCompleted) {
      const errors = cleanupState(state, (args) => runSecurity(args));
      writeCleanupState(
        cleanupStatePath,
        errors.length === 0 ? { completed: true } : state,
      );
      if (errors.length > 0)
        throw new Error(`credential cleanup failed: ${errors.join("; ")}`);
    }
  }
}

main().catch((error) => {
  core.setFailed(
    String(error?.message || error)
      .replace(/\r?\n/gu, " ")
      .slice(0, 2000),
  );
});
