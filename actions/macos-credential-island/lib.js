import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateArtifactSigningRequest } from "../../packages/core/artifact-signing.js";

export const INPUT_CONTRACT = "buildchain.macos-credential-input/v1";
export const EVIDENCE_CONTRACT =
  "buildchain.macos-credential-island-evidence/v1";
export const SHA1_PATTERN = /^[0-9a-f]{40}$/i;
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/i;
export const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
export const API_KEY_ID_PATTERN = /^[A-Z0-9]{10}$/;
export const API_ISSUER_PATTERN = /^[0-9a-f-]{36}$/i;
export const MACH_O_MAGICS = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
]);

export const ENTITLEMENTS_PROFILES = Object.freeze({
  "electron-desktop-v1": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
`,
});

export function requirePattern(value, pattern, label) {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) {
    throw new Error(`${label} has an invalid format`);
  }
  return normalized;
}

export function requireSha(value, label) {
  return requirePattern(value, SHA1_PATTERN, label).toLowerCase();
}

export function requireRepository(value) {
  return requirePattern(value, REPOSITORY_PATTERN, "source-repository");
}

export function safeArtifactStem(value) {
  const stem = String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!stem || stem === "." || stem === "..") {
    throw new Error("artifact-stem resolves to an unsafe filename");
  }
  return stem;
}

export function safePlatformId(value) {
  const platformId = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(platformId)) {
    throw new Error(
      "platform-id must be a safe Buildchain platform identifier",
    );
  }
  return platformId;
}

export function safeArtifactName(value) {
  const artifactName = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(artifactName)) {
    throw new Error(
      "artifact-name must be a safe Buildchain artifact identifier",
    );
  }
  return artifactName;
}

export function sha256Buffer(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function decodeBase64Secret(
  value,
  label,
  { minBytes = 1, maxBytes = 1024 * 1024 } = {},
) {
  const compact = String(value || "").replace(/\s+/g, "");
  if (
    !compact ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length < minBytes || decoded.length > maxBytes) {
    throw new Error(
      `${label} decoded byte length is outside the allowed boundary`,
    );
  }
  const roundTrip = decoded.toString("base64").replace(/=+$/u, "");
  if (roundTrip !== compact.replace(/=+$/u, "")) {
    throw new Error(`${label} base64 did not round-trip`);
  }
  return decoded;
}

export function resolveInside(root, relativePath, label) {
  const absoluteRoot = path.resolve(root);
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(
      `${label} must be a relative path without parent traversal`,
    );
  }
  const resolved = path.resolve(absoluteRoot, normalized);
  const relative = path.relative(absoluteRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve below its declared root`);
  }
  return resolved;
}

export function assertRealPathInside(root, target, label) {
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(realRoot, realTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside its declared root`);
  }
  return realTarget;
}

export function assertContainedSymlinks(root) {
  const absoluteRoot = path.resolve(root);
  const realRoot = fs.realpathSync(absoluteRoot);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(target);
        if (path.isAbsolute(link)) {
          throw new Error("sealed app contains an absolute symbolic link");
        }
        const resolved = fs.realpathSync(target);
        const relative = path.relative(realRoot, resolved);
        if (
          !relative ||
          relative.startsWith("..") ||
          path.isAbsolute(relative)
        ) {
          throw new Error(
            "sealed app contains a symbolic link outside the app bundle",
          );
        }
      } else if (stat.isDirectory()) {
        visit(target);
      }
    }
  };
  visit(absoluteRoot);
}

export function isMachOHeader(buffer) {
  return buffer.length >= 4 && MACH_O_MAGICS.has(buffer.readUInt32BE(0));
}

export function isMacCodeArtifact(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory())
    return /\.(?:app|appex|bundle|framework|xpc)$/iu.test(filePath);
  if (!stat.isFile()) return false;
  const descriptor = fs.openSync(filePath, "r");
  const header = Buffer.alloc(4);
  try {
    return (
      fs.readSync(descriptor, header, 0, 4, 0) === 4 && isMachOHeader(header)
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

export function signingIgnore(filePath) {
  try {
    return !isMacCodeArtifact(filePath);
  } catch {
    return false;
  }
}

export function loadCredentialInput(inputRoot, expected = {}) {
  const manifests = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "credential-input.json")
        manifests.push(target);
    }
  };
  visit(path.resolve(inputRoot));
  if (manifests.length !== 1) {
    throw new Error(
      `expected one credential-input.json under input-root, found ${manifests.length}`,
    );
  }
  const manifestPath = manifests[0];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== INPUT_CONTRACT)
    throw new Error(`credential input must use ${INPUT_CONTRACT}`);
  const repository = requireRepository(manifest.source?.repository);
  const sourceSha = requireSha(
    manifest.source?.sha,
    "credential input source SHA",
  );
  const sourceTreeSha = requireSha(
    manifest.source?.treeSha,
    "credential input source tree SHA",
  );
  if (expected.repository && repository !== expected.repository)
    throw new Error("credential input repository mismatch");
  if (expected.sourceSha && sourceSha !== expected.sourceSha)
    throw new Error("credential input source SHA mismatch");
  if (expected.sourceTreeSha && sourceTreeSha !== expected.sourceTreeSha)
    throw new Error("credential input source tree SHA mismatch");
  if (manifest.platform?.os !== "macos")
    throw new Error("credential input platform must be macos");
  if (!["arm64", "x64"].includes(manifest.platform?.arch))
    throw new Error("credential input architecture is unsupported");
  if (
    !manifest.app?.bundleId ||
    !manifest.app?.productName ||
    !manifest.app?.version
  ) {
    throw new Error("credential input app identity is incomplete");
  }
  if (expected.bundleId && manifest.app.bundleId !== expected.bundleId) {
    throw new Error("credential input bundle identifier mismatch");
  }
  const archivePath = resolveInside(
    path.dirname(manifestPath),
    manifest.archive?.file,
    "credential input archive",
  );
  if (!fs.statSync(archivePath).isFile())
    throw new Error("credential input archive is not a file");
  assertRealPathInside(
    path.dirname(manifestPath),
    archivePath,
    "credential input archive",
  );
  const expectedDigest = requirePattern(
    manifest.archive?.sha256,
    SHA256_PATTERN,
    "credential input archive digest",
  ).toLowerCase();
  if (sha256File(archivePath) !== expectedDigest)
    throw new Error("credential input archive digest mismatch");
  if (Number(manifest.archive?.bytes) !== fs.statSync(archivePath).size)
    throw new Error("credential input archive size mismatch");
  return { manifest, manifestPath, archivePath };
}

export function loadArtifactSigningInput(inputRoot, expected = {}) {
  const requests = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "request.json")
        requests.push(target);
    }
  };
  const root = path.resolve(inputRoot);
  visit(root);
  const candidates = requests
    .map((requestPath) => ({
      requestPath,
      request: JSON.parse(fs.readFileSync(requestPath, "utf8")),
    }))
    .filter(
      ({ request }) => request.signature?.profile === "apple-developer-id",
    );
  if (candidates.length !== 1) {
    throw new Error(
      `expected one apple-developer-id request.json under input-root, found ${candidates.length}`,
    );
  }
  const { requestPath, request } = candidates[0];
  const check = validateArtifactSigningRequest(request);
  if (!check.ok) {
    throw new Error(
      `artifact signing request is invalid: ${check.issues.join(", ")}`,
    );
  }
  if (request.artifact.platform !== "macos") {
    throw new Error("artifact signing request platform must be macos");
  }
  if (request.artifact.kind !== "app-bundle") {
    throw new Error(
      `apple authority adapter does not yet support ${request.artifact.kind}; expected app-bundle`,
    );
  }
  const repository = requireRepository(request.source.repository);
  const sourceSha = requireSha(
    request.source.sha,
    "artifact signing source SHA",
  );
  const sourceTreeSha = requireSha(
    request.source.treeSha,
    "artifact signing source tree SHA",
  );
  const runtimeSha = requireSha(
    request.runtime.sha,
    "artifact signing runtime SHA",
  );
  if (expected.repository && repository !== expected.repository)
    throw new Error("artifact signing request repository mismatch");
  if (expected.sourceSha && sourceSha !== expected.sourceSha)
    throw new Error("artifact signing request source SHA mismatch");
  if (expected.sourceTreeSha && sourceTreeSha !== expected.sourceTreeSha)
    throw new Error("artifact signing request source tree SHA mismatch");
  if (expected.runtimeSha && runtimeSha !== expected.runtimeSha)
    throw new Error("artifact signing request runtime SHA mismatch");
  const transport = request.artifact.transport;
  if (transport?.format !== "ditto-zip") {
    throw new Error("apple app signing request must use ditto-zip transport");
  }
  const archivePath = resolveInside(
    root,
    transport.file,
    "artifact signing transport",
  );
  if (!fs.statSync(archivePath).isFile()) {
    throw new Error("artifact signing transport is not a file");
  }
  assertRealPathInside(root, archivePath, "artifact signing transport");
  if (sha256File(archivePath) !== transport.digest) {
    throw new Error("artifact signing transport digest mismatch");
  }
  if (fs.statSync(archivePath).size !== transport.bytes) {
    throw new Error("artifact signing transport size mismatch");
  }
  const archivePathInPayload = path.basename(request.artifact.path);
  return {
    request,
    requestPath,
    manifestPath: requestPath,
    archivePath,
    manifest: {
      schema: request.contract,
      source: request.source,
      platform: {
        id: String(expected.platformId || "macos"),
        os: "macos",
        arch: request.artifact.arch,
      },
      app: {
        archivePath: archivePathInPayload,
        productName: archivePathInPayload.replace(/\.app$/iu, ""),
      },
      archive: {
        file: transport.file,
        format: transport.format,
        bytes: transport.bytes,
        sha256: transport.digest,
      },
    },
  };
}

export function loadMacosSigningInput(inputRoot, expected = {}) {
  try {
    return loadArtifactSigningInput(inputRoot, expected);
  } catch (genericError) {
    try {
      return loadCredentialInput(inputRoot, expected);
    } catch (legacyError) {
      throw new Error(
        `macOS signing input is neither a generic artifact request nor a legacy credential input: ${genericError.message}; ${legacyError.message}`,
      );
    }
  }
}

export function parseIdentityListing(output, expectedSha1) {
  const expected = requireSha(expectedSha1, "certificate-sha1").toUpperCase();
  const matches = String(output || "")
    .split(/\r?\n/u)
    .map((line) => line.match(/\b([0-9A-F]{40})\b.*"([^"]+)"/u))
    .filter(Boolean)
    .map((match) => ({ sha1: match[1], subject: match[2] }));
  const selected = matches.filter((identity) => identity.sha1 === expected);
  if (selected.length !== 1)
    throw new Error(
      "temporary keychain does not contain exactly one requested identity",
    );
  if (!selected[0].subject.startsWith("Developer ID Application:")) {
    throw new Error(
      "requested identity is not a Developer ID Application certificate",
    );
  }
  return selected[0];
}

export function parseNotarySubmission(output, label) {
  let value;
  try {
    value = JSON.parse(String(output || ""));
  } catch {
    throw new Error(`${label} notarization did not return JSON`);
  }
  if (!/^[0-9a-f-]{36}$/iu.test(String(value.id || ""))) {
    throw new Error(`${label} notarization did not return a submission id`);
  }
  if (!/^[A-Za-z][A-Za-z -]{0,63}$/u.test(String(value.status || ""))) {
    throw new Error(`${label} notarization did not return a bounded status`);
  }
  return { id: value.id, status: value.status };
}

export function parseNotaryResult(output, label) {
  const result = parseNotarySubmission(output, label);
  if (result.status !== "Accepted") {
    throw new Error(`${label} notarization was not accepted`);
  }
  return result;
}

function boundedNotaryText(value, maxLength) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "<email>")
    .replace(
      /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^/\\\s]+[/\\]/gu,
      "<home>/",
    )
    .replace(
      /\b(token|secret|password|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$1=<redacted>",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function summarizeNotaryLog(output, label) {
  let value;
  try {
    value = JSON.parse(String(output || ""));
  } catch {
    throw new Error(`${label} notarization log did not return JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} notarization log did not return an object`);
  }
  const issues = (Array.isArray(value.issues) ? value.issues : [])
    .filter(
      (issue) => issue && typeof issue === "object" && !Array.isArray(issue),
    )
    .slice(0, 5)
    .map((issue) => ({
      severity: boundedNotaryText(issue.severity, 32),
      code: boundedNotaryText(issue.code, 64),
      path: boundedNotaryText(issue.path, 240),
      message: boundedNotaryText(issue.message, 400),
      architecture: boundedNotaryText(issue.architecture, 32),
    }));
  return {
    status: boundedNotaryText(value.status, 64),
    statusCode: boundedNotaryText(value.statusCode, 64),
    statusSummary: boundedNotaryText(value.statusSummary, 400),
    issues,
  };
}

export function entitlementsForProfile(profile) {
  const value = ENTITLEMENTS_PROFILES[String(profile || "")];
  if (!value)
    throw new Error(
      `unsupported entitlements profile: ${profile || "<empty>"}`,
    );
  return { name: profile, content: value, sha256: sha256Buffer(value) };
}

export function signingOptionsForFile(entitlementsPath) {
  const resolved = String(entitlementsPath || "").trim();
  if (!resolved) {
    throw new Error("Buildchain-owned entitlements path is required");
  }
  return () => ({
    entitlements: resolved,
    hardenedRuntime: true,
  });
}

export function cleanupState(state, runSecurity = () => {}) {
  const errors = [];
  if (
    Array.isArray(state?.originalKeychains) &&
    state.originalKeychains.length > 0
  ) {
    try {
      runSecurity([
        "list-keychains",
        "-d",
        "user",
        "-s",
        ...state.originalKeychains,
      ]);
    } catch (error) {
      errors.push(`restore keychain search list: ${error.message}`);
    }
  }
  if (state?.temporaryKeychain) {
    try {
      runSecurity(["delete-keychain", state.temporaryKeychain]);
    } catch (error) {
      if (fs.existsSync(state.temporaryKeychain))
        errors.push(`delete temporary keychain: ${error.message}`);
    }
  }
  if (state?.temporaryRoot) {
    try {
      fs.rmSync(state.temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      errors.push(`remove temporary root: ${error.message}`);
    }
  }
  return errors;
}

export function createCredentialArtifactManifest({
  artifactName,
  platform,
  repository,
  sourceSha,
  sourceRef = "",
  artifactRoot,
  files,
  runId = "",
  runAttempt = "",
}) {
  const normalizedArtifactName = safeArtifactName(artifactName);
  const normalizedPlatform = {
    id: safePlatformId(platform?.id),
    name: String(platform?.name || platform?.id || "").trim(),
    os: "macos",
    arch: String(platform?.arch || "").trim(),
  };
  if (
    !normalizedPlatform.name ||
    !["arm64", "x64"].includes(normalizedPlatform.arch)
  ) {
    throw new Error("credential artifact platform identity is incomplete");
  }
  const root = path.resolve(artifactRoot);
  const normalizedFiles = [...files]
    .map((filePath) => {
      const resolved = path.resolve(filePath);
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("credential artifact file must be below artifact-root");
      }
      return {
        path: relative.split(path.sep).join("/"),
        size: fs.statSync(resolved).size,
        sha256: sha256File(resolved).slice("sha256:".length),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const digest = crypto.createHash("sha256");
  for (const file of normalizedFiles) {
    digest.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  const summary = {
    contract: "kungfu-buildchain-artifact-summary",
    artifactName: normalizedArtifactName,
    platform: normalizedPlatform,
    fileCount: normalizedFiles.length,
    totalBytes: normalizedFiles.reduce((sum, file) => sum + file.size, 0),
    digest: digest.digest("hex"),
  };
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact",
    artifactName: normalizedArtifactName,
    platform: normalizedPlatform,
    git: {
      repository: requireRepository(repository),
      sha: requireSha(sourceSha, "credential artifact source SHA"),
      ref: String(sourceRef || ""),
      runId: String(runId || ""),
      runAttempt: String(runAttempt || ""),
    },
    lifecycle: {
      stage: "credential-island",
      commandSource: "buildchain-action",
      executed: true,
    },
    summary,
    expectedArtifacts: {
      ok: normalizedFiles.length >= 3,
      source: EVIDENCE_CONTRACT,
      checks: [
        {
          name: "signed-output-count",
          ok: normalizedFiles.length >= 3,
          detail: `${normalizedFiles.length} >= 3`,
        },
      ],
    },
    files: normalizedFiles,
  };
}
