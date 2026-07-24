import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { sealArtifactVerificationReport } from "./artifact-verification-envelope.js";
import { readJsonFromLocation, sha256File, verifyReleasePassport } from "./release-passport.js";

export const ARTIFACT_VERIFICATION_CONTRACT = "kungfu-buildchain-artifact-verification";
export const ARTIFACT_PASSPORT_POINTER_CONTRACT = "kungfu-buildchain-artifact-passport-pointer";
export const ARTIFACT_PASSPORT_LOCATOR_CONTRACT = "kungfu-buildchain-artifact-passport-locator";
export const DEFAULT_NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org/";

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function isHttpLocation(value = "") {
  return /^https?:\/\//i.test(String(value));
}

function isRemoteSubject(value = "") {
  return isHttpLocation(value) || /^(npm|oci|s3|deployment|github-release):/i.test(String(value));
}

function issue(level, code, message, details = {}) {
  return { level, code, message, details };
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function sha512IntegrityBuffer(buffer) {
  return `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
}

export function sha512IntegrityFile(filePath) {
  return sha512IntegrityBuffer(fs.readFileSync(filePath));
}

async function readBufferFromHttp(location) {
  const client = location.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    client
      .get(location, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} while reading ${location}`));
          response.resume();
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function readTextMaybe(location) {
  if (isHttpLocation(location)) {
    return (await readBufferFromHttp(location)).toString("utf8");
  }
  return fs.readFileSync(location, "utf8");
}

function readJsonMaybe(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function digestDirectory(dir) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(dir, fullPath).split(path.sep).join("/");
        files.push({
          path: relativePath,
          size: fs.statSync(fullPath).size,
          sha256: sha256File(fullPath),
        });
      }
    }
  };
  visit(dir);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n");
  return {
    sha256: sha256Buffer(Buffer.from(manifest, "utf8")),
    fileCount: files.length,
  };
}

function inferKindFromName(name = "") {
  const lower = name.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".msi") || lower.endsWith(".dmg") || lower.endsWith(".pkg")) {
    return "native-installer";
  }
  if (lower.endsWith(".tgz")) {
    return "npm-package";
  }
  if (lower.endsWith(".zip") || lower.endsWith(".tar.gz") || lower.endsWith(".tar.xz") || lower.endsWith(".tar")) {
    return "archive";
  }
  return "artifact";
}

function parseNpmSubject(subject) {
  const spec = subject.replace(/^npm:/, "");
  const atIndex = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.lastIndexOf("@");
  if (atIndex <= 0) {
    return { name: spec, version: "" };
  }
  return { name: spec.slice(0, atIndex), version: spec.slice(atIndex + 1) };
}

function normalizeNpmRegistryBaseUrl(value = "") {
  const registry = optionalString(value || process.env.npm_config_registry || DEFAULT_NPM_REGISTRY_BASE_URL).trim();
  return registry.endsWith("/") ? registry : `${registry}/`;
}

function npmRegistryPackageMetadataUrl(name, registryBaseUrl = "") {
  return new URL(encodeURIComponent(name), normalizeNpmRegistryBaseUrl(registryBaseUrl)).toString();
}

async function resolveNpmSubjectDigest({ name, version, registryBaseUrl = "" } = {}) {
  if (!name || !version) {
    return { status: "skipped", reason: "missing-name-or-version" };
  }
  const metadataUrl = npmRegistryPackageMetadataUrl(name, registryBaseUrl);
  const metadata = await readJsonFromLocation(metadataUrl);
  const versionMetadata = metadata?.versions?.[version];
  if (!versionMetadata) {
    return {
      status: "missing",
      reason: "version-not-found",
      registry: normalizeNpmRegistryBaseUrl(registryBaseUrl),
      metadataUrl,
    };
  }
  const integrity = optionalString(versionMetadata.dist?.integrity);
  const shasum = optionalString(versionMetadata.dist?.shasum);
  const digest = integrity || (shasum ? `sha1:${shasum}` : "");
  return {
    status: digest ? "resolved" : "missing",
    reason: digest ? "" : "dist-integrity-missing",
    registry: normalizeNpmRegistryBaseUrl(registryBaseUrl),
    metadataUrl,
    digest,
    integrity,
    shasum,
    tarball: optionalString(versionMetadata.dist?.tarball),
  };
}

function parseGitHubReleaseSubject(subject) {
  const value = subject.replace(/^github-release:/, "");
  const match = value.match(/^([^/]+\/[^@/]+)@([^/]+)\/(.+)$/);
  if (!match) {
    return {};
  }
  return { repository: match[1], tag: match[2], name: match[3] };
}

function parseGitHubReleaseUrl(location) {
  try {
    const parsed = new URL(location);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/);
    if (!match) {
      return {};
    }
    return {
      repository: `${match[1]}/${match[2]}`,
      tag: decodeURIComponent(match[3]),
      name: decodeURIComponent(match[4]),
    };
  } catch {
    return {};
  }
}

function resolveLocation(baseLocation, relativeLocation) {
  const relative = optionalString(relativeLocation).trim();
  if (!relative) {
    return "";
  }
  if (isHttpLocation(relative) || isRemoteSubject(relative)) {
    return relative;
  }
  if (isHttpLocation(baseLocation)) {
    return new URL(relative, baseLocation).toString();
  }
  return path.resolve(path.dirname(baseLocation), relative);
}

async function readOptionalJson(location) {
  if (!location) {
    return {};
  }
  try {
    return await readJsonFromLocation(location);
  } catch {
    return {};
  }
}

function relativeTo(baseDir, maybeRelative) {
  if (!maybeRelative) {
    return "";
  }
  if (isHttpLocation(maybeRelative) || isRemoteSubject(maybeRelative) || path.isAbsolute(maybeRelative)) {
    return maybeRelative;
  }
  return path.resolve(baseDir, maybeRelative);
}

async function readPassportPointer(pointerLocation) {
  const pointer = JSON.parse(await readTextMaybe(pointerLocation));
  const passport = pointer.passport || pointer.passportLocation || pointer.releasePassport || pointer.url || "";
  if (!passport) {
    throw new Error(`passport pointer ${pointerLocation} does not include passport`);
  }
  return {
    pointer,
    passportLocation: resolveLocation(pointerLocation, passport),
  };
}

function localConfigCandidates({ cwd, subject }) {
  const starts = [cwd];
  if (subject.localPath) {
    starts.push(subject.kind === "directory" || subject.kind === "npm-package" ? subject.localPath : path.dirname(subject.localPath));
  }
  const seen = new Set();
  const result = [];
  for (const start of starts) {
    let current = path.resolve(start || cwd);
    while (!seen.has(current)) {
      seen.add(current);
      for (const name of [
        ".buildchain/artifact-passport-locators.json",
        "buildchain.artifact-passport.json",
      ]) {
        result.push(path.join(current, name));
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return result;
}

function locatorMatchesSubject(locator, subject) {
  const match = locator.match || locator.subject || {};
  const digest = optionalString(match.digest || match.sha256 || match.integrity);
  if (digest && !subjectDigestMatches(subject, digest)) {
    return false;
  }
  for (const [left, right] of [
    [match.name, subject.name],
    [match.kind, subject.kind],
    [match.version || match.ref, subject.version],
    [match.repository, subject.githubRelease?.repository],
    [match.tag, subject.githubRelease?.tag],
  ]) {
    if (left && right && String(left) !== String(right)) {
      return false;
    }
    if (left && !right) {
      return false;
    }
  }
  return true;
}

async function readLocatorConfig(location, baseDir) {
  const resolved = relativeTo(baseDir, location);
  const value = await readJsonFromLocation(resolved);
  const locators = Array.isArray(value) ? value : value.locators || value.passports || [];
  return { location: resolved, locators };
}

async function findPassportInLocator(location, subject, baseDir) {
  const config = await readLocatorConfig(location, baseDir);
  for (const locator of config.locators) {
    if (!locatorMatchesSubject(locator, subject)) {
      continue;
    }
    const passportLocation = locator.passport || locator.passportLocation || locator.releasePassport || locator.url || "";
    if (passportLocation) {
      return {
        passportLocation: resolveLocation(config.location, passportLocation),
        locator: config.location,
        entry: locator,
      };
    }
  }
  return undefined;
}

function sidecarPointerCandidates(subject) {
  if (!subject.localPath) {
    return [];
  }
  const candidates = [];
  if (subject.kind === "directory" || subject.kind === "npm-package") {
    candidates.push(path.join(subject.localPath, ".buildchain-passport.json"));
    candidates.push(path.join(subject.localPath, ".buildchain", "artifact-passport.json"));
  } else {
    candidates.push(`${subject.localPath}.buildchain-passport.json`);
    candidates.push(`${subject.localPath}.passport.json`);
    candidates.push(path.join(path.dirname(subject.localPath), ".buildchain-passport.json"));
  }
  return candidates;
}

function embeddedPointerCandidates(subject) {
  if (!subject.packageJsonPath || !fs.existsSync(subject.packageJsonPath)) {
    return [];
  }
  const packageJson = readJsonMaybe(subject.packageJsonPath);
  const passport =
    packageJson.buildchain?.releasePassport ||
    packageJson.buildchain?.passport ||
    packageJson.releasePassport ||
    "";
  return passport
    ? [{ passport, packageJsonPath: subject.packageJsonPath }]
    : [];
}

function releaseTagForArtifactVersion(version = "") {
  const value = optionalString(version).trim();
  if (!value) {
    return "";
  }
  return value.startsWith("v") ? value : `v${value}`;
}

function githubReleasePassportLocations(subject, options) {
  const repository = options.repository || subject.githubRelease?.repository || "";
  if (!repository) {
    return [];
  }
  const tags = [
    subject.githubRelease?.tag,
    releaseTagForArtifactVersion(subject.version),
    options.tag,
  ].map(optionalString).filter(Boolean);
  const uniqueTags = [...new Set(tags)];
  const baseUrl = (options.githubReleaseBaseUrl || "https://github.com").replace(/\/$/, "");
  return uniqueTags.map((tag) => ({
    tag,
    repository,
    location: `${baseUrl}/${repository}/releases/download/${encodeURIComponent(tag)}/buildchain.release.json`,
  }));
}

export async function resolveArtifactSubject(subject, {
  cwd = process.cwd(),
  subjectDigest = "",
  subjectKind = "",
  npmRegistryBaseUrl = "",
} = {}) {
  const input = optionalString(subject).trim();
  if (!input) {
    throw new Error("artifact subject must be a non-empty string");
  }
  if (/^npm:/i.test(input)) {
    const parsed = parseNpmSubject(input);
    let npmDigest = {};
    if (!subjectDigest) {
      try {
        npmDigest = await resolveNpmSubjectDigest({
          name: parsed.name,
          version: parsed.version,
          registryBaseUrl: npmRegistryBaseUrl,
        });
      } catch (error) {
        npmDigest = {
          status: "error",
          registry: normalizeNpmRegistryBaseUrl(npmRegistryBaseUrl),
          error: error.message,
        };
      }
    }
    const digest = subjectDigest || npmDigest.digest || "";
    return {
      input,
      kind: subjectKind || "npm-package",
      name: parsed.name,
      version: parsed.version,
      digest,
      integrity: npmDigest.integrity || (digest.startsWith("sha512-") ? digest : ""),
      shasum: npmDigest.shasum || "",
      registry: npmDigest.registry || normalizeNpmRegistryBaseUrl(npmRegistryBaseUrl),
      npm: {
        digestResolution: npmDigest.status || (subjectDigest ? "provided" : "skipped"),
        metadataUrl: npmDigest.metadataUrl || "",
        tarball: npmDigest.tarball || "",
        error: npmDigest.error || "",
      },
      localPath: "",
    };
  }
  if (/^github-release:/i.test(input)) {
    const parsed = parseGitHubReleaseSubject(input);
    return {
      input,
      kind: subjectKind || inferKindFromName(parsed.name || input),
      name: parsed.name || input,
      version: "",
      digest: subjectDigest,
      localPath: "",
      githubRelease: parsed,
    };
  }
  if (/^(oci|s3|deployment):/i.test(input)) {
    return {
      input,
      kind: subjectKind || input.split(":", 1)[0],
      name: input,
      version: "",
      digest: subjectDigest,
      localPath: "",
    };
  }
  if (isHttpLocation(input)) {
    const buffer = await readBufferFromHttp(input);
    const githubRelease = parseGitHubReleaseUrl(input);
    return {
      input,
      kind: subjectKind || inferKindFromName(githubRelease.name || path.basename(new URL(input).pathname)),
      name: githubRelease.name || path.basename(new URL(input).pathname),
      version: "",
      digest: subjectDigest || `sha256:${sha256Buffer(buffer)}`,
      sha256: sha256Buffer(buffer),
      integrity: sha512IntegrityBuffer(buffer),
      size: buffer.length,
      localPath: "",
      githubRelease,
    };
  }
  const localPath = path.resolve(cwd, input);
  if (!fs.existsSync(localPath)) {
    return {
      input,
      kind: subjectKind || inferKindFromName(path.basename(input)),
      name: path.basename(input),
      version: "",
      digest: subjectDigest,
      localPath,
      missing: true,
    };
  }
  const stat = fs.statSync(localPath);
  if (stat.isDirectory()) {
    const packageJsonPath = path.join(localPath, "package.json");
    const packageJson = fs.existsSync(packageJsonPath) ? readJsonMaybe(packageJsonPath) : {};
    const directoryDigest = digestDirectory(localPath);
    return {
      input,
      kind: subjectKind || (packageJson.name ? "npm-package" : "directory"),
      name: packageJson.name || path.basename(localPath),
      version: packageJson.version || "",
      digest: subjectDigest || `sha256:${directoryDigest.sha256}`,
      sha256: directoryDigest.sha256,
      integrity: "",
      size: stat.size,
      fileCount: directoryDigest.fileCount,
      localPath,
      packageJsonPath: fs.existsSync(packageJsonPath) ? packageJsonPath : "",
    };
  }
  const buffer = fs.readFileSync(localPath);
  const sha256 = sha256Buffer(buffer);
  return {
    input,
    kind: subjectKind || inferKindFromName(path.basename(localPath)),
    name: path.basename(localPath),
    version: "",
    digest: subjectDigest || `sha256:${sha256}`,
    sha256,
    integrity: sha512IntegrityBuffer(buffer),
    size: stat.size,
    localPath,
  };
}

export async function discoverArtifactPassport({
  subject,
  cwd = process.cwd(),
  passportLocation = "",
  locatorConfig = "",
  repository = "",
  tag = "",
  githubReleaseBaseUrl = "",
} = {}) {
  const attempts = [];
  const found = (method, location, details = {}) => ({
    status: "found",
    method,
    passportLocation: location,
    attempts: attempts.concat({ method, status: "found", location, details }),
    details,
  });
  if (passportLocation) {
    const resolved = relativeTo(cwd, passportLocation);
    return found("explicit-passport", resolved);
  }
  for (const candidate of sidecarPointerCandidates(subject)) {
    attempts.push({ method: "sidecar-pointer", location: candidate, status: fs.existsSync(candidate) ? "found" : "miss" });
    if (fs.existsSync(candidate)) {
      const pointer = await readPassportPointer(candidate);
      return found("sidecar-pointer", pointer.passportLocation, { pointer: candidate });
    }
  }
  for (const pointer of embeddedPointerCandidates(subject)) {
    attempts.push({ method: "embedded-package-pointer", location: pointer.packageJsonPath, status: "found" });
    return found("embedded-package-pointer", resolveLocation(pointer.packageJsonPath, pointer.passport), {
      packageJson: pointer.packageJsonPath,
    });
  }
  for (const candidate of localConfigCandidates({ cwd, subject })) {
    attempts.push({ method: "local-config-index", location: candidate, status: fs.existsSync(candidate) ? "checked" : "miss" });
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const matched = await findPassportInLocator(candidate, subject, cwd);
    if (matched) {
      return found("local-config-index", matched.passportLocation, { locator: matched.locator });
    }
  }
  const githubLocations = githubReleasePassportLocations(subject, { repository, tag, githubReleaseBaseUrl });
  for (const githubLocation of githubLocations) {
    try {
      await readJsonFromLocation(githubLocation.location);
      attempts.push({
        method: "github-release-default",
        location: githubLocation.location,
        status: "found",
        details: { repository: githubLocation.repository, tag: githubLocation.tag },
      });
      return found("github-release-default", githubLocation.location, {
        repository: githubLocation.repository,
        tag: githubLocation.tag,
      });
    } catch (error) {
      attempts.push({
        method: "github-release-default",
        location: githubLocation.location,
        status: "miss",
        error: error.message,
        details: { repository: githubLocation.repository, tag: githubLocation.tag },
      });
    }
  }
  if (locatorConfig) {
    const resolved = relativeTo(cwd, locatorConfig);
    attempts.push({ method: "custom-locator", location: resolved, status: fs.existsSync(resolved) || isHttpLocation(resolved) ? "checked" : "miss" });
    let matched;
    try {
      matched = await findPassportInLocator(resolved, subject, cwd);
    } catch (error) {
      attempts.push({ method: "custom-locator", location: resolved, status: "error", error: error.message });
    }
    if (matched) {
      return found("custom-locator", matched.passportLocation, { locator: matched.locator });
    }
  }
  return {
    status: "unverifiable",
    method: "unresolved",
    passportLocation: "",
    attempts: attempts.concat({
      method: "unverifiable",
      status: "unverifiable",
      guidance: "Provide --passport, add a sidecar pointer, publish buildchain.release.json to the GitHub Release, or configure a locator.",
    }),
  };
}

function digestValues(value = {}) {
  return [
    value.digest,
    value.sha256 ? `sha256:${value.sha256}` : "",
    value.integrity,
    value.shasum,
  ].map(optionalString).filter(Boolean);
}

function normalizeDigest(value = "") {
  return optionalString(value).trim();
}

function digestEquivalent(left = "", right = "") {
  const a = normalizeDigest(left);
  const b = normalizeDigest(right);
  if (!a || !b) {
    return false;
  }
  return a === b || a === `sha256:${b}` || `sha256:${a}` === b;
}

function subjectDigestMatches(subject, digest) {
  return digestValues(subject).some((value) => digestEquivalent(value, digest));
}

function packageSetArtifacts(passport = {}) {
  const packageSet = passport.packageSet || {};
  return [
    ...(packageSet.main?.name ? [{ role: "main", ...packageSet.main }] : []),
    ...((packageSet.platforms || []).map((entry) => ({ role: "platform", ...entry }))),
  ].map((entry) => ({
    group: "node",
    kind: "npm",
    name: entry.name,
    ref: entry.version,
    digest: entry.digest,
    role: entry.role,
    platform: entry.platform || "",
    source: "packageSet",
  }));
}

function publishSummaryArtifacts(passport = {}) {
  return (passport.publish?.packages || []).map((entry) => ({
    group: "node",
    kind: "npm",
    name: entry.name,
    ref: entry.publishedVersion || entry.version,
    digest: entry.digest,
    role: entry.role,
    platform: entry.platform || "",
    source: "publish.packages",
  }));
}

function passportArtifacts({ passport = {}, artifactEvidence = {}, publishEvidence = {} } = {}) {
  return [
    ...(passport.artifacts || []).map((entry) => ({ ...entry, source: "passport.artifacts" })),
    ...(artifactEvidence.artifacts || []).map((entry) => ({ ...entry, source: "artifact-evidence.artifacts" })),
    ...(publishEvidence.artifacts || []).map((entry) => ({ ...entry, source: "publish-evidence.artifacts" })),
    ...packageSetArtifacts(passport),
    ...publishSummaryArtifacts(passport),
  ];
}

function artifactMatchesSubject(artifact, subject) {
  const artifactDigests = digestValues(artifact);
  const digestMatch = artifactDigests.some((digest) => subjectDigestMatches(subject, digest));
  const nameMatch = !artifact.name || !subject.name || artifact.name === subject.name;
  const refMatch = !artifact.ref || !subject.version || artifact.ref === subject.version;
  const packageIdentityMatch =
    subject.kind === "npm-package" &&
    artifact.name === subject.name &&
    (!artifact.ref || !subject.version || artifact.ref === subject.version);
  if (digestMatch && (nameMatch || packageIdentityMatch)) {
    return { matched: true, reason: "digest" };
  }
  if (digestMatch) {
    return { matched: true, reason: "digest-only" };
  }
  return { matched: false, reason: packageIdentityMatch ? "package-identity-without-digest" : "no-match" };
}

async function loadPassportBundle(passportLocation) {
  const passport = await readJsonFromLocation(passportLocation);
  const artifactEvidenceLocation = resolveLocation(passportLocation, passport.evidence?.artifactEvidence);
  const publishEvidenceLocation = resolveLocation(passportLocation, passport.evidence?.publishEvidence);
  const impactLocation = resolveLocation(passportLocation, passport.evidence?.impact);
  const agentIndexLocation = resolveLocation(passportLocation, passport.evidence?.agentIndex);
  const productMechanismLocation = resolveLocation(passportLocation, passport.product?.mechanism);
  const [artifactEvidence, publishEvidence] = await Promise.all([
    readOptionalJson(artifactEvidenceLocation),
    readOptionalJson(publishEvidenceLocation),
  ]);
  return {
    passport,
    artifactEvidence,
    publishEvidence,
    locations: {
      artifactEvidenceLocation,
      publishEvidenceLocation,
      impactLocation,
      agentIndexLocation,
      productMechanismLocation,
    },
  };
}

export async function verifyArtifactPassport({
  subject,
  cwd = process.cwd(),
  passportLocation = "",
  locatorConfig = "",
  repository = "",
  tag = "",
  githubReleaseBaseUrl = "",
  subjectDigest = "",
  subjectKind = "",
  npmRegistryBaseUrl = "",
  verificationEnvelope = undefined,
} = {}) {
  const resolvedSubject = await resolveArtifactSubject(subject, { cwd, subjectDigest, subjectKind, npmRegistryBaseUrl });
  const issues = [];
  if (resolvedSubject.missing) {
    issues.push(issue("error", "subject.missing", "artifact subject does not exist locally", { subject: resolvedSubject.input }));
    return {
      schemaVersion: 1,
      contract: ARTIFACT_VERIFICATION_CONTRACT,
      outcome: "unverifiable",
      ok: false,
      trust: "unverifiable",
      subject: resolvedSubject,
      discovery: { status: "unverifiable", method: "subject-missing", attempts: [] },
      issues,
    };
  }
  const discovery = await discoverArtifactPassport({
    subject: resolvedSubject,
    cwd,
    passportLocation,
    locatorConfig,
    repository,
    tag,
    githubReleaseBaseUrl,
  });
  if (!discovery.passportLocation) {
    issues.push(issue("error", "passport.unavailable", "no release passport could be discovered for artifact subject"));
    return {
      schemaVersion: 1,
      contract: ARTIFACT_VERIFICATION_CONTRACT,
      outcome: "unverifiable",
      ok: false,
      trust: "unverifiable",
      subject: resolvedSubject,
      discovery,
      issues,
    };
  }
  let bundle;
  let passportReport;
  try {
    bundle = await loadPassportBundle(discovery.passportLocation);
    passportReport = await verifyReleasePassport({
      passportLocation: discovery.passportLocation,
      artifactEvidenceLocation: bundle.locations.artifactEvidenceLocation,
      publishEvidenceLocation: bundle.locations.publishEvidenceLocation,
      impactLocation: bundle.locations.impactLocation,
      agentIndexLocation: bundle.locations.agentIndexLocation,
      productMechanismLocation: bundle.locations.productMechanismLocation,
    });
  } catch (error) {
    issues.push(issue("error", "passport.read", "release passport could not be read or parsed", {
      passportLocation: discovery.passportLocation,
      error: error.message,
    }));
    return {
      schemaVersion: 1,
      contract: ARTIFACT_VERIFICATION_CONTRACT,
      outcome: "fail",
      ok: false,
      trust: "fail",
      subject: resolvedSubject,
      discovery,
      issues,
    };
  }
  if (!passportReport.ok) {
    issues.push(issue("error", "passport.verification", "release passport verification failed"));
  }
  const candidates = passportArtifacts(bundle);
  const match = candidates.map((artifact) => ({ artifact, result: artifactMatchesSubject(artifact, resolvedSubject) }))
    .find((entry) => entry.result.matched);
  if (!match) {
    issues.push(issue("error", "subject.digest.missing", "artifact subject digest was not found in the release passport evidence", {
      digest: resolvedSubject.digest || resolvedSubject.integrity || "",
      name: resolvedSubject.name,
      kind: resolvedSubject.kind,
    }));
  }
  const ok = passportReport.ok && Boolean(match);
  const outcome = ok ? "pass" : "fail";
  const report = {
    schemaVersion: 1,
    contract: ARTIFACT_VERIFICATION_CONTRACT,
    outcome,
    ok,
    trust: outcome,
    subject: resolvedSubject,
    discovery,
    passport: {
      location: discovery.passportLocation,
      product: bundle.passport.product,
      release: bundle.passport.release,
      verification: {
        ok: passportReport.ok,
        trust: passportReport.trust,
        completeness: passportReport.completeness,
        issues: passportReport.issues,
      },
    },
    match: match
      ? {
          source: match.artifact.source,
          reason: match.result.reason,
          artifact: match.artifact,
        }
      : undefined,
    issues,
  };
  return verificationEnvelope
    ? sealArtifactVerificationReport({ report, ...verificationEnvelope })
    : report;
}

export async function explainArtifactPassport(options = {}) {
  const report = await verifyArtifactPassport(options);
  const nextAction = report.ok
    ? "use-artifact-after-policy-review"
    : report.outcome === "unverifiable"
      ? "locate-passport-or-add-artifact-passport-pointer"
      : "block-artifact-and-report-verification-failure";
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-explanation",
    audience: options.forAudience || "human",
    subject: report.subject,
    outcome: report.outcome,
    trust: report.trust,
    passport: report.passport,
    discovery: report.discovery,
    match: report.match,
    nextAction,
    issues: report.issues,
  };
}
