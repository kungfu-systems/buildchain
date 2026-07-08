import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { loadBuildchainConfig } from "./buildchain-config.js";
import {
  readJsonFromLocation,
  verifyReleasePassport,
} from "./release-passport.js";

export const README_BADGE_FACTS_CONTRACT = "kungfu-buildchain-readme-badge-facts";
export const BADGE_BUNDLE_FACTS_CONTRACT = "kungfu-buildchain-badge-bundle-facts";
export const README_BADGE_BLOCK_START = "<!-- buildchain:badges:start -->";
export const README_BADGE_BLOCK_END = "<!-- buildchain:badges:end -->";
export const README_BADGE_HOSTED_BASE_URL = "https://buildchain.libkungfu.dev/badges/v1";
export const BADGE_BUNDLE_DEFAULT_CLAIMS = [
  "kfd-1",
  "kfd-2",
  "kfd-3",
  "release-passport",
];

const KFD_KEYS = [
  { key: "kfd-1", id: "kfd1", label: "KFD-1", text: "contract world" },
  { key: "kfd-2", id: "kfd2", label: "KFD-2", text: "trust passport" },
  { key: "kfd-3", id: "kfd3", label: "KFD-3", text: "collaboration interface" },
];

const KFD_BADGE_CONCEPTS = {
  "kfd-1": "contractWorld",
  "kfd-2": "releaseTrustPassport",
  "kfd-3": "collaborationInterface",
};

const requireFromHere = createRequire(import.meta.url);

const STATE_COLORS = {
  passed: "2ea44f",
  aligned: "0969da",
  declared: "6e7781",
  planned: "bf8700",
  draft: "8250df",
  downgraded: "bf8700",
  failed: "cf222e",
  missing: "6e7781",
  unknown: "6e7781",
};

const BUILDCHAIN_BADGE_IDS = [
  "kfd-1",
  "kfd-2",
  "kfd-3",
  "buildchain-release-passport",
];

const BADGE_BUNDLE_CLAIM_ALIASES = {
  kfd1: "kfd-1",
  "kfd_1": "kfd-1",
  "kfd-1": "kfd-1",
  kfd2: "kfd-2",
  "kfd_2": "kfd-2",
  "kfd-2": "kfd-2",
  kfd3: "kfd-3",
  "kfd_3": "kfd-3",
  "kfd-3": "kfd-3",
  passport: "release-passport",
  "release_passport": "release-passport",
  "release-passport": "release-passport",
  "buildchain-release-passport": "release-passport",
};

const BUILDCHAIN_BADGE_LOGO_PLACEHOLDER = {
  contract: "kungfu-buildchain-badge-logo-policy",
  mode: "hosted-placeholder",
  placeholder: "buildchain-monogram",
  futureLogoUpdateRequiresConsumerAction: false,
  owner: "Buildchain site badge endpoint",
  note: "README image URLs point at stable Buildchain-hosted badge endpoints; the rendered logo is controlled by the endpoint, not by consumer README text.",
};

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readPackageJsonForResolvedFile(filePath) {
  let current = path.dirname(filePath);
  while (current && current !== path.dirname(current)) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      return readJsonIfExists(packagePath) || {};
    }
    current = path.dirname(current);
  }
  return {};
}

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function posixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function encodeBadge(value) {
  return encodeURIComponent(String(value || ""))
    .replace(/-/g, "--")
    .replace(/_/g, "__");
}

function badgeUrl({ label, message, color }) {
  return `https://img.shields.io/badge/${encodeBadge(label)}-${encodeBadge(message)}-${color || "6e7781"}.svg`;
}

function badgeEndpointBaseUrl(badgeConfig = {}) {
  return String(
    badgeConfig.badge_endpoint_base_url ||
    badgeConfig.badgeEndpointBaseUrl ||
    README_BADGE_HOSTED_BASE_URL,
  ).replace(/\/+$/, "");
}

function hostedBadgeUrl({ badgeConfig = {}, id, state }) {
  return `${badgeEndpointBaseUrl(badgeConfig)}/${encodeURIComponent(id)}/${encodeURIComponent(state || "unknown")}.svg`;
}

export function createReadmeBadgeEndpointRegistry({ kfdSpecs = KFD_KEYS } = {}) {
  const states = Object.keys(STATE_COLORS).filter((state) => state !== "unknown");
  const specs = [
    ...kfdSpecs.map((entry) => ({
      id: entry.key,
      label: entry.label,
      messageTemplate: `${entry.text} {state}`,
      linkRole: "repository-release-passport",
    })),
    {
      id: "buildchain-release-passport",
      label: "buildchain",
      messageTemplate: "release passport {state}",
      linkRole: "repository-release-passport",
    },
  ];
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-readme-badge-endpoint-registry",
    endpointBaseUrl: README_BADGE_HOSTED_BASE_URL,
    imagePathTemplate: "/badges/v1/{badge}/{state}.svg",
    jsonPathTemplate: "/badges/v1/{badge}/{state}.json",
    consumerActionForLogoChange: "none",
    logoPolicy: BUILDCHAIN_BADGE_LOGO_PLACEHOLDER,
    shieldsEndpointCompatible: true,
    badges: specs.map((spec) => ({
      ...spec,
      states: states.map((state) => ({
        state,
        path: `badges/v1/${spec.id}/${state}.json`,
        svgPath: `badges/v1/${spec.id}/${state}.svg`,
        payload: {
          schemaVersion: 1,
          label: spec.label,
          message: spec.messageTemplate.replace("{state}", state),
          color: STATE_COLORS[state] || STATE_COLORS.unknown,
          logoPolicy: BUILDCHAIN_BADGE_LOGO_PLACEHOLDER,
        },
      })),
    })),
  };
}

function normalizeState(value, fallback = "planned") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (["passed", "aligned", "declared", "planned", "draft", "downgraded", "failed", "missing"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeDeclarationState(value, fallback = "planned") {
  const normalized = normalizeState(value, fallback);
  return normalized === "passed" ? "declared" : normalized;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function splitClaimList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value.split(",");
  }
  return [];
}

function normalizeBadgeBundleClaims(value, fallback = BADGE_BUNDLE_DEFAULT_CLAIMS) {
  const selected = [];
  const unknown = [];
  for (const claim of splitClaimList(value)) {
    const key = String(claim || "").trim().toLowerCase();
    if (!key) {
      continue;
    }
    const normalized = BADGE_BUNDLE_CLAIM_ALIASES[key];
    if (!normalized) {
      unknown.push(key);
      continue;
    }
    if (!selected.includes(normalized)) {
      selected.push(normalized);
    }
  }
  if (unknown.length > 0) {
    throw new Error(`unsupported badge bundle claim(s): ${unknown.join(", ")}`);
  }
  return selected.length > 0 ? selected : [...fallback];
}

function badgeBundleConfig(badgeConfig = {}) {
  const configured = badgeConfig.bundle && typeof badgeConfig.bundle === "object"
    ? badgeConfig.bundle
    : {};
  return {
    enabled: configured.enabled === undefined ? true : Boolean(configured.enabled),
    claims: normalizeBadgeBundleClaims(configured.claims || badgeConfig.bundle_claims || badgeConfig.bundleClaims),
    mode: String(configured.mode || "readme"),
    hosted: configured.hosted === undefined ? true : Boolean(configured.hosted),
  };
}

function resolveLocalFactPath({ cwd, location }) {
  const value = String(location || "").trim();
  if (!value || /^https?:\/\//.test(value)) {
    return "";
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function kfdStandardsLocation({ cwd, badgeConfig = {} }) {
  return String(
    badgeConfig.kfd_standards ||
    badgeConfig.kfdStandards ||
    badgeConfig.kfd_standards_path ||
    badgeConfig.kfdStandardsPath ||
    process.env.BUILDCHAIN_KFD_STANDARDS_PATH ||
    "",
  ).trim();
}

async function loadKfdStandards({ cwd, badgeConfig = {} }) {
  const configured = kfdStandardsLocation({ cwd, badgeConfig });
  if (configured) {
    const localPath = resolveLocalFactPath({ cwd, location: configured });
    const value = /^https?:\/\//.test(configured)
      ? await readJsonFromLocation(configured)
      : readJsonIfExists(localPath);
    if (!value || typeof value !== "object") {
      throw new Error(`KFD standards metadata is not readable: ${configured}`);
    }
    return {
      location: configured,
      resolvedPath: localPath,
      source: /^https?:\/\//.test(configured) ? "configured-url" : "configured-path",
      sha256: localPath && fs.existsSync(localPath) ? sha256File(localPath) : hashText(JSON.stringify(value)),
      package: {},
      value,
      error: "",
    };
  }
  try {
    const resolvedPath = requireFromHere.resolve("@kungfu-tech/kfd/standards.json", {
      paths: [cwd],
    });
    const value = readJsonIfExists(resolvedPath);
    const packageJson = readPackageJsonForResolvedFile(resolvedPath);
    return {
      location: "@kungfu-tech/kfd/standards.json",
      resolvedPath,
      source: "package-export",
      sha256: sha256File(resolvedPath),
      package: {
        name: packageJson.name || "@kungfu-tech/kfd",
        version: packageJson.version || "",
      },
      value,
      error: "",
    };
  } catch (error) {
    return {
      location: "@kungfu-tech/kfd/standards.json",
      resolvedPath: "",
      source: "fallback",
      sha256: "",
      package: {},
      value: undefined,
      error: error.message,
    };
  }
}

function summarizeKfdStandards(loaded) {
  const standards = loaded?.value?.standards && typeof loaded.value.standards === "object"
    ? loaded.value.standards
    : {};
  const summary = {
    contract: loaded?.value?.contract || "",
    schemaVersion: loaded?.value?.schemaVersion || undefined,
    metadataSchema: loaded?.value?.metadataSchema || undefined,
    source: loaded?.source || "fallback",
    location: loaded?.location || "",
    sha256: loaded?.sha256 || "",
    package: loaded?.package || {},
    error: loaded?.error || "",
    standards: {},
  };
  for (const fallback of KFD_KEYS) {
    const standard = standards[fallback.key] || {};
    const conceptKey = KFD_BADGE_CONCEPTS[fallback.key];
    summary.standards[fallback.key] = {
      key: standard.key || fallback.key,
      id: standard.id || fallback.label,
      label: standard.label || fallback.label,
      title: standard.title || "",
      status: standard.status || "",
      revision: standard.revision || undefined,
      documentUrl: standard.document?.url || "",
      documentPath: standard.document?.path || "",
      documentSha256: standard.document?.sha256 || "",
      badgeText: standard.concepts?.[conceptKey] || fallback.text,
      interfaceContract: conceptKey ? standard.interfaces?.[conceptKey]?.contract || "" : "",
      schemaId: conceptKey ? standard.interfaces?.[conceptKey]?.schemaId || standard.schemaIds?.[conceptKey] || "" : "",
    };
  }
  return summary;
}

function kfdBadgeSpecs(kfdStandards) {
  return KFD_KEYS.map((fallback) => {
    const standard = kfdStandards?.standards?.[fallback.key] || {};
    return {
      ...fallback,
      label: standard.label || fallback.label,
      text: standard.badgeText || fallback.text,
      title: standard.title || "",
      standardDocumentUrl: standard.documentUrl || "",
      standardDocumentSha256: standard.documentSha256 || "",
      interfaceContract: standard.interfaceContract || "",
      schemaId: standard.schemaId || "",
    };
  });
}

function readRepositoryFromGit(cwd) {
  const remote = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd,
    encoding: "utf8",
  });
  const value = remote.status === 0 ? remote.stdout.trim() : "";
  const match = value.match(/github\.com[:/]([^/\s]+)\/([^/\s.]+)(?:\.git)?$/);
  if (!match) {
    return { fullName: "", owner: "", name: "", url: "" };
  }
  const fullName = `${match[1]}/${match[2]}`;
  return {
    fullName,
    owner: match[1],
    name: match[2],
    url: `https://github.com/${fullName}`,
  };
}

function normalizePackageRepository(repository) {
  const value = typeof repository === "string" ? repository : repository?.url || "";
  const match = String(value).match(/github\.com[:/]([^/\s]+)\/([^/\s.]+)(?:\.git)?/);
  if (!match) {
    return undefined;
  }
  const fullName = `${match[1]}/${match[2]}`;
  return {
    fullName,
    owner: match[1],
    name: match[2],
    url: `https://github.com/${fullName}`,
  };
}

function discoverWorkflowFacts({ cwd, repository, badgeConfig = {} }) {
  const workflowDir = path.join(cwd, ".github", "workflows");
  const configured = normalizeStringArray(badgeConfig.workflows);
  const defaults = ["verify.yml", "build.yml", "buildchain-ref-promotion.yml"];
  const names = configured.length > 0 ? configured : defaults;
  if (!fs.existsSync(workflowDir)) {
    return [];
  }
  return names
    .map((file) => {
      const workflowPath = path.join(workflowDir, file);
      if (!fs.existsSync(workflowPath)) {
        return undefined;
      }
      const source = fs.readFileSync(workflowPath, "utf8");
      const nameMatch = source.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      const name = String(nameMatch?.[1] || path.basename(file, path.extname(file))).trim();
      return {
        file,
        name,
        badgeUrl: repository.fullName
          ? `https://github.com/${repository.fullName}/actions/workflows/${file}/badge.svg`
          : "",
        url: repository.fullName
          ? `https://github.com/${repository.fullName}/actions/workflows/${file}`
          : "",
      };
    })
    .filter(Boolean);
}

function defaultReleasePassportLocation({ cwd, repository, badgeConfig = {} }) {
  const configured = badgeConfig.release_passport_url || badgeConfig.releasePassportUrl || badgeConfig.release_passport || "";
  if (configured) {
    return String(configured);
  }
  const localCandidates = [
    "buildchain.release.json",
    ".buildchain/release-passport/buildchain.release.json",
  ];
  for (const candidate of localCandidates) {
    const filePath = path.join(cwd, candidate);
    if (fs.existsSync(filePath)) {
      return candidate;
    }
  }
  return repository.fullName
    ? `https://github.com/${repository.fullName}/releases/latest/download/buildchain.release.json`
    : "";
}

function siblingUrl(location, filename) {
  if (!/^https?:\/\//.test(location)) {
    return "";
  }
  return `${location.replace(/\/[^/]*$/, "")}/${filename}`;
}

async function readPassportAndReport({ cwd, location }) {
  if (!location) {
    return { passport: undefined, report: undefined, error: "" };
  }
  const resolvedLocation = /^https?:\/\//.test(location) ? location : path.resolve(cwd, location);
  try {
    const passport = await readJsonFromLocation(resolvedLocation);
    const report = await verifyReleasePassport({
      passportLocation: resolvedLocation,
      artifactEvidenceLocation: siblingUrl(resolvedLocation, "artifact-evidence.json"),
      impactLocation: siblingUrl(resolvedLocation, "impact.json"),
      agentIndexLocation: siblingUrl(resolvedLocation, "agent-index.json"),
      productMechanismLocation: siblingUrl(resolvedLocation, "product-mechanism.json"),
    });
    return { passport, report, error: "" };
  } catch (error) {
    return { passport: undefined, report: undefined, error: error.message };
  }
}

function kfdSectionPassed({ passport, report, key }) {
  if (!passport || !report?.ok) {
    return false;
  }
  const section = passport[key] || (key === "kfd-1" ? passport.kfd1 : undefined) || (key === "kfd-3" ? passport.kfd3 : undefined);
  return section?.status === "passed";
}

function declaredKfdState({ badgeConfig = {}, key, id }) {
  const kfdConfig = badgeConfig.kfd && typeof badgeConfig.kfd === "object" ? badgeConfig.kfd : {};
  return normalizeDeclarationState(
    badgeConfig[key] ||
      badgeConfig[id] ||
      badgeConfig[key.replace("-", "_")] ||
      kfdConfig[key] ||
      kfdConfig[id] ||
      kfdConfig[key.replace("kfd-", "")],
    "planned",
  );
}

function releasePassportState({ report, error, badgeConfig = {} }) {
  if (report?.ok) {
    return "passed";
  }
  if (error) {
    return normalizeDeclarationState(badgeConfig.release_passport_state || badgeConfig.releasePassportState, "declared");
  }
  return normalizeDeclarationState(badgeConfig.release_passport_state || badgeConfig.releasePassportState, "planned");
}

function licenseFromFiles(cwd, packageJson) {
  if (packageJson.license) {
    return String(packageJson.license);
  }
  const licenseFile = fs.readdirSync(cwd).find((entry) => /^licen[sc]e($|\.)/i.test(entry));
  return licenseFile ? licenseFile.replace(/^LICENSE[.-]?/i, "") || "present" : "";
}

function collectPlatformFacts({ badgeConfig = {}, passport = undefined }) {
  const configured = normalizeStringArray(badgeConfig.platforms);
  if (configured.length > 0) {
    return configured;
  }
  const assets = Array.isArray(passport?.artifacts) ? passport.artifacts : [];
  const platforms = new Set();
  for (const asset of assets) {
    const platform = String(asset.platform || "").trim();
    if (platform) {
      platforms.add(platform);
    }
  }
  return [...platforms].sort();
}

function localFactFileSummary(cwd, candidates = []) {
  for (const relPath of candidates) {
    const filePath = path.join(cwd, relPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      continue;
    }
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        location: relPath,
        sha256: sha256File(filePath),
        contract: value.contract || "",
        claimCount: Array.isArray(value.publicClaims) ? value.publicClaims.length : undefined,
        category: value.category || "",
      };
    } catch (error) {
      return {
        location: relPath,
        error: error.message,
      };
    }
  }
  return undefined;
}

function buildBadgeEntries(facts, { badgeConfig = {} } = {}) {
  const entries = [];
  for (const kfd of facts.kfd) {
    entries.push({
      id: kfd.key,
      alt: `${kfd.label}: ${kfd.state}`,
      image: hostedBadgeUrl({ badgeConfig, id: kfd.key, state: kfd.state }),
      link: kfd.url,
    });
  }
  entries.push({
    id: "buildchain-release-passport",
    alt: `Buildchain Release Passport: ${facts.releasePassport.state}`,
    image: hostedBadgeUrl({ badgeConfig, id: "buildchain-release-passport", state: facts.releasePassport.state }),
    link: facts.releasePassport.url,
  });
  if (facts.package.license) {
    entries.push({
      id: "license",
      alt: `License: ${facts.package.license}`,
      image: badgeUrl({ label: "license", message: facts.package.license, color: "0969da" }),
      link: facts.repository.url ? `${facts.repository.url}/blob/HEAD/LICENSE` : "",
    });
  }
  if (facts.platforms.length > 0) {
    entries.push({
      id: "platform",
      alt: `Platform: ${facts.platforms.join(" | ")}`,
      image: badgeUrl({ label: "platform", message: facts.platforms.join(" | "), color: "6e7781" }),
      link: facts.releasePassport.url,
    });
  }
  for (const workflow of facts.workflows) {
    entries.push({
      id: `workflow:${workflow.file}`,
      alt: workflow.name,
      image: workflow.badgeUrl,
      link: workflow.url,
    });
  }
  return entries;
}

function buildBadgeBundleEntries(readmeFacts, bundle) {
  const selected = new Set(bundle.claims);
  const entries = [];
  for (const kfd of readmeFacts.kfd) {
    if (!selected.has(kfd.key)) {
      continue;
    }
    entries.push({
      id: kfd.key,
      claim: kfd.key,
      alt: `${kfd.label}: ${kfd.state}`,
      image: readmeFacts.badges.find((badge) => badge.id === kfd.key)?.image || "",
      link: kfd.url,
      state: kfd.state,
      source: kfd.source,
      standard: {
        title: kfd.title,
        documentUrl: kfd.standardDocumentUrl,
        documentSha256: kfd.standardDocumentSha256,
        interfaceContract: kfd.interfaceContract,
        schemaId: kfd.schemaId,
      },
    });
  }
  if (selected.has("release-passport")) {
    const badge = readmeFacts.badges.find((entry) => entry.id === "buildchain-release-passport");
    entries.push({
      id: "buildchain-release-passport",
      claim: "release-passport",
      alt: `Buildchain Release Passport: ${readmeFacts.releasePassport.state}`,
      image: badge?.image || "",
      link: readmeFacts.releasePassport.url,
      state: readmeFacts.releasePassport.state,
      source: readmeFacts.releasePassport.verified ? "release-passport" : "declaration",
      releasePassport: readmeFacts.releasePassport,
    });
  }
  return entries;
}

export async function collectReadmeBadgeFacts({ cwd = process.cwd() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const loadedConfig = loadBuildchainConfig(resolvedCwd);
  const badgeConfig = loadedConfig?.config?.badges && typeof loadedConfig.config.badges === "object"
    ? loadedConfig.config.badges
    : {};
  const packageJson = readJsonIfExists(path.join(resolvedCwd, "package.json")) || {};
  const packageRepository = normalizePackageRepository(packageJson.repository);
  const repository = packageRepository || readRepositoryFromGit(resolvedCwd);
  const releasePassportLocation = defaultReleasePassportLocation({ cwd: resolvedCwd, repository, badgeConfig });
  const { passport, report, error } = await readPassportAndReport({
    cwd: resolvedCwd,
    location: releasePassportLocation,
  });
  const releasePassportUrl = /^https?:\/\//.test(releasePassportLocation)
    ? releasePassportLocation
    : repository.fullName && releasePassportLocation
      ? `${repository.url}/blob/HEAD/${posixPath(releasePassportLocation)}`
      : releasePassportLocation;
  const releaseState = releasePassportState({ report, error, badgeConfig });
  const kfdStandards = summarizeKfdStandards(await loadKfdStandards({ cwd: resolvedCwd, badgeConfig }));
  const kfd = kfdBadgeSpecs(kfdStandards).map((entry) => {
    const passed = kfdSectionPassed({ passport, report, key: entry.key });
    const state = passed ? "passed" : declaredKfdState({ badgeConfig, key: entry.key, id: entry.id });
    return {
      key: entry.key,
      label: entry.label,
      text: entry.text,
      title: entry.title,
      standardDocumentUrl: entry.standardDocumentUrl,
      standardDocumentSha256: entry.standardDocumentSha256,
      interfaceContract: entry.interfaceContract,
      schemaId: entry.schemaId,
      state,
      source: passed ? "release-passport" : "declaration",
      url: releasePassportUrl,
    };
  });
  const facts = {
    schemaVersion: 1,
    contract: README_BADGE_FACTS_CONTRACT,
    cwd: resolvedCwd,
    repository,
    package: {
      name: packageJson.name || "",
      version: packageJson.version || "",
      license: licenseFromFiles(resolvedCwd, packageJson),
    },
    releasePassport: {
      location: releasePassportLocation,
      url: releasePassportUrl,
      state: releaseState,
      verified: Boolean(report?.ok),
      error,
      reportSummary: report ? {
        ok: report.ok,
        trust: report.trust,
        issueCount: Array.isArray(report.issues) ? report.issues.length : 0,
      } : undefined,
    },
    kfdClaimRegistry: localFactFileSummary(resolvedCwd, [
      "dist/site/kfd-claims.json",
      ".buildchain/kfd-claims.json",
    ]),
    kfdStandards,
    productMechanism: localFactFileSummary(resolvedCwd, [
      "dist/site/product-mechanism.json",
      "product-mechanism.json",
      ".buildchain/product-mechanism.json",
    ]),
    kfd,
    platforms: collectPlatformFacts({ badgeConfig, passport }),
    workflows: discoverWorkflowFacts({ cwd: resolvedCwd, repository, badgeConfig }),
    badgeRuntime: {
      provider: "buildchain-hosted",
      endpointBaseUrl: badgeEndpointBaseUrl(badgeConfig),
      hostedBadgeIds: BUILDCHAIN_BADGE_IDS,
      logoPolicy: BUILDCHAIN_BADGE_LOGO_PLACEHOLDER,
    },
    badgeBundle: badgeBundleConfig(badgeConfig),
    badges: [],
  };
  facts.badges = buildBadgeEntries(facts, { badgeConfig });
  return facts;
}

export async function collectBadgeBundleFacts({ cwd = process.cwd(), claims = undefined } = {}) {
  const readmeFacts = await collectReadmeBadgeFacts({ cwd });
  const config = {
    ...readmeFacts.badgeBundle,
    claims: normalizeBadgeBundleClaims(claims, readmeFacts.badgeBundle.claims),
  };
  const badges = buildBadgeBundleEntries(readmeFacts, config);
  return {
    schemaVersion: 1,
    contract: BADGE_BUNDLE_FACTS_CONTRACT,
    cwd: readmeFacts.cwd,
    repository: readmeFacts.repository,
    package: readmeFacts.package,
    sourceFactsContract: readmeFacts.contract,
    sourceFactsSha256: hashText(JSON.stringify(readmeFacts)),
    policy: {
      defaultClaims: [...BADGE_BUNDLE_DEFAULT_CLAIMS],
      claims: config.claims,
      hosted: config.hosted,
      mode: config.mode,
      passedRequiresRepositoryPassport: true,
      consumerActionForLogoChange: "none",
    },
    releasePassport: readmeFacts.releasePassport,
    kfdStandards: readmeFacts.kfdStandards,
    kfdClaimRegistry: readmeFacts.kfdClaimRegistry,
    productMechanism: readmeFacts.productMechanism,
    badgeRuntime: readmeFacts.badgeRuntime,
    badges,
  };
}

function renderBadgeMarkdownBlock(facts) {
  const lines = [
    README_BADGE_BLOCK_START,
    ...facts.badges.map((badge) => (
      badge.link
        ? `[![${badge.alt}](${badge.image})](${badge.link})`
        : `![${badge.alt}](${badge.image})`
    )),
    README_BADGE_BLOCK_END,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderReadmeBadgeBlock(facts) {
  return renderBadgeMarkdownBlock(facts);
}

export function renderBadgeBundleBlock(facts) {
  return renderBadgeMarkdownBlock(facts);
}

function badgeBlockRegex() {
  return new RegExp(`${README_BADGE_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${README_BADGE_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`);
}

export function checkReadmeBadgeBlock({ readmeText, facts } = {}) {
  const expected = renderBadgeMarkdownBlock(facts);
  const match = String(readmeText || "").match(badgeBlockRegex());
  const actual = match ? match[0] : "";
  const normalizedActual = actual.endsWith("\n") ? actual : `${actual}\n`;
  const ok = normalizedActual === expected;
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-readme-badge-check",
    ok,
    missing: !match,
    stale: Boolean(match) && !ok,
    expected,
    actual,
    facts,
    message: ok ? "README badge block is current" : (match ? "README badge block is stale" : "README badge block is missing"),
  };
}

export function checkBadgeBundleBlock({ readmeText, facts } = {}) {
  return {
    ...checkReadmeBadgeBlock({ readmeText, facts }),
    contract: "kungfu-buildchain-badge-bundle-check",
  };
}

export function updateReadmeBadgeBlock({ readmeText, facts } = {}) {
  const source = String(readmeText || "");
  const block = renderReadmeBadgeBlock(facts);
  if (badgeBlockRegex().test(source)) {
    return source.replace(badgeBlockRegex(), block);
  }
  const h1 = source.match(/^# .+\n+/);
  if (h1) {
    return `${h1[0]}${block}\n${source.slice(h1[0].length)}`;
  }
  return `${block}\n${source}`;
}

export function updateBadgeBundleBlock({ readmeText, facts } = {}) {
  return updateReadmeBadgeBlock({ readmeText, facts });
}

export function readReadme({ cwd = process.cwd(), readmePath = "README.md" } = {}) {
  return readTextIfExists(path.resolve(cwd, readmePath));
}
