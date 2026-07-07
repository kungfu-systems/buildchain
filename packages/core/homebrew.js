import fs from "node:fs";
import path from "node:path";
import { readJsonFromLocation, sha256Text, verifyReleasePassport } from "./release-passport.js";

export const HOMEBREW_TAP_FACTS_CONTRACT = "kungfu-buildchain-homebrew-tap-facts";
export const HOMEBREW_TAP_CHECK_CONTRACT = "kungfu-buildchain-homebrew-tap-check";
export const HOMEBREW_TAP_MANIFEST_CONTRACT = "kungfu-buildchain-homebrew-tap-manifest";

const DEFAULT_MANIFEST_PATH = "tap-manifest.json";
const DEFAULT_FORMULA_PATH = "Formula/buildchain.rb";
const KFD_KEYS = ["kfd-1", "kfd-2", "kfd-3"];
const SUPPORTED_FORMULA_PLATFORMS = new Set(["darwin-arm64", "linux-x64"]);

function readJsonFile(filePath, fallback = undefined) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function nonEmptyString(value, label) {
  const normalized = optionalString(value).trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function digestWithoutPrefix(value) {
  return optionalString(value).replace(/^sha256:/, "");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function formulaClassName(name) {
  return nonEmptyString(name, "package name")
    .replace(/^@[^/]+\//, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function rubyString(value) {
  return optionalString(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function inferPlatformFromName(name) {
  const lower = optionalString(name).toLowerCase();
  if (lower.includes("apple-darwin") || lower.includes("darwin") || lower.includes("macos")) {
    return lower.includes("aarch64") || lower.includes("arm64") ? "darwin-arm64" : "darwin-x64";
  }
  if (lower.includes("windows") || lower.includes("pc-windows") || lower.endsWith(".zip")) {
    return "windows-x64";
  }
  if (lower.includes("linux") || lower.includes("unknown-linux")) {
    return lower.includes("aarch64") || lower.includes("arm64") ? "linux-arm64" : "linux-x64";
  }
  return "";
}

function normalizeRepository(value = "") {
  const raw = optionalString(value).trim();
  if (!raw) return "";
  const githubMatch = raw.match(/github\.com[:/]([^/\s]+\/[^/\s#]+?)(?:\.git)?(?:[#/?].*)?$/);
  if (githubMatch) return githubMatch[1].replace(/\.git$/, "");
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return raw.replace(/\.git$/, "");
  return raw;
}

function releaseDirectoryUrl(releasePassportLocation = "") {
  if (!/^https?:\/\//.test(releasePassportLocation)) return "";
  const url = new URL(releasePassportLocation);
  url.pathname = url.pathname.replace(/\/[^/]*$/, "/");
  return url.toString();
}

function githubAssetUrl(repository, tag, name) {
  const repo = normalizeRepository(repository);
  if (!repo || !tag || !name) return "";
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function siblingAssetUrl(releasePassportLocation, name) {
  const base = releaseDirectoryUrl(releasePassportLocation);
  return base ? new URL(encodeURIComponent(name), base).toString() : "";
}

function normalizeArtifact(artifact, { releasePassportLocation = "", repository = "", tag = "" } = {}) {
  const name = nonEmptyString(artifact.name || artifact.filename, "artifact.name");
  const platform = optionalString(artifact.platform || inferPlatformFromName(name));
  return {
    name,
    platform,
    url: optionalString(artifact.url || artifact.browser_download_url || artifact.downloadUrl)
      || siblingAssetUrl(releasePassportLocation, name)
      || githubAssetUrl(repository, tag, name),
    sha256: digestWithoutPrefix(artifact.sha256 || artifact.digest || artifact.checksum),
  };
}

function formulaArchiveArtifacts(passport, context) {
  return (passport.artifacts || [])
    .map((artifact) => normalizeArtifact(artifact, context))
    .filter((artifact) => SUPPORTED_FORMULA_PLATFORMS.has(artifact.platform))
    .filter((artifact) => /\.(?:tar\.gz|tgz)$/i.test(artifact.name))
    .sort((left, right) => left.platform.localeCompare(right.platform));
}

function readTapManifest(cwd, manifestPath = DEFAULT_MANIFEST_PATH) {
  const filePath = path.join(cwd, manifestPath);
  const manifest = readJsonFile(filePath, {
    schema: 1,
    contract: HOMEBREW_TAP_MANIFEST_CONTRACT,
    name: "",
    kind: "homebrew-tap",
    entries: [],
  });
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must be a JSON object`);
  }
  if (manifest.schema !== undefined && manifest.schema !== 1) {
    throw new Error(`${manifestPath} schema must be 1`);
  }
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    throw new Error(`${manifestPath} schemaVersion must be 1`);
  }
  if (manifest.entries !== undefined && !Array.isArray(manifest.entries)) {
    throw new Error(`${manifestPath} entries must be an array`);
  }
  return manifest;
}

function findManifestEntry(manifest, packageName) {
  return (manifest.entries || []).find((entry) => entry?.type === "formula" && entry.name === packageName);
}

async function verifyPassportLocation(location) {
  try {
    const report = await verifyReleasePassport({ passportLocation: location });
    return { ok: report.ok === true, report, error: "" };
  } catch (error) {
    return { ok: false, report: undefined, error: error.message };
  }
}

function createKfdProjection(passport, verified) {
  return Object.fromEntries(KFD_KEYS.map((key) => [
    key,
    verified && passport?.[key]?.status === "passed" ? "passed" : "unverified",
  ]));
}

function createManifestProjection({
  manifest,
  entry,
  packageName,
  formulaPath,
  releasePassportLocation,
  passport,
  artifacts,
  kfd,
  repository,
} = {}) {
  const tag = nonEmptyString(passport.release?.tag, "release.tag");
  const version = nonEmptyString(passport.release?.publishedVersion || passport.release?.versionLabel, "release.publishedVersion");
  const repo = normalizeRepository(repository || entry?.upstream?.repository || passport.product?.repository);
  const latestReleasePassportUrl = optionalString(entry?.upstream?.latestReleasePassportUrl)
    || (repo ? `https://github.com/${repo}/releases/latest/download/buildchain.release.json` : "");
  return {
    schema: 1,
    contract: HOMEBREW_TAP_MANIFEST_CONTRACT,
    name: optionalString(manifest.name || (repo ? `${repo.replace(/\/[^/]+$/, "")}/homebrew-tap` : "")),
    kind: "homebrew-tap",
    entries: [
      {
        type: "formula",
        name: packageName,
        path: formulaPath,
        upstream: {
          repository: repo,
          tag,
          releasePassportUrl: releasePassportLocation,
          latestReleasePassportUrl,
        },
        version,
        kfd,
        artifacts: artifacts.map((artifact) => ({
          platform: artifact.platform,
          url: artifact.url,
          sha256: artifact.sha256,
        })),
      },
    ],
  };
}

export async function collectHomebrewTapFacts({
  cwd = process.cwd(),
  packageName = "buildchain",
  releasePassport = "",
  manifestPath = DEFAULT_MANIFEST_PATH,
  formulaPath = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const manifest = readTapManifest(resolvedCwd, manifestPath);
  const entry = findManifestEntry(manifest, packageName);
  const selectedFormulaPath = formulaPath || entry?.path || (packageName === "buildchain" ? DEFAULT_FORMULA_PATH : `Formula/${packageName}.rb`);
  const releasePassportLocation = nonEmptyString(
    releasePassport || entry?.upstream?.releasePassportUrl || entry?.releasePassport,
    "release passport",
  );
  const passport = await readJsonFromLocation(releasePassportLocation);
  const verification = await verifyPassportLocation(releasePassportLocation);
  const repository = normalizeRepository(entry?.upstream?.repository || passport.product?.repository);
  const artifacts = formulaArchiveArtifacts(passport, {
    releasePassportLocation,
    repository,
    tag: passport.release?.tag,
  });
  const kfd = createKfdProjection(passport, verification.ok);
  const manifestProjection = createManifestProjection({
    manifest,
    entry,
    packageName,
    formulaPath: selectedFormulaPath,
    releasePassportLocation,
    passport,
    artifacts,
    kfd,
    repository,
  });
  return {
    schemaVersion: 1,
    contract: HOMEBREW_TAP_FACTS_CONTRACT,
    cwd: resolvedCwd,
    package: {
      name: packageName,
      formulaClass: formulaClassName(packageName),
      desc: optionalString(entry?.formula?.desc || "Release passport and build evidence toolkit"),
      homepage: optionalString(entry?.formula?.homepage || passport.product?.homepage || "https://buildchain.libkungfu.dev"),
      license: optionalString(entry?.formula?.license || "Apache-2.0"),
    },
    releasePassport: {
      location: releasePassportLocation,
      verified: verification.ok,
      verificationError: verification.error,
      report: verification.report,
    },
    release: {
      tag: passport.release?.tag || "",
      version: passport.release?.publishedVersion || passport.release?.versionLabel || "",
      repository,
    },
    formula: {
      path: selectedFormulaPath,
      artifacts,
    },
    kfd,
    manifestPath,
    manifestProjection,
  };
}

export function renderHomebrewFormula(facts) {
  if (!facts || facts.contract !== HOMEBREW_TAP_FACTS_CONTRACT) {
    throw new Error("facts must be collected with collectHomebrewTapFacts");
  }
  const artifacts = facts.formula?.artifacts || [];
  const darwinArm64 = artifacts.find((artifact) => artifact.platform === "darwin-arm64");
  const linuxX64 = artifacts.find((artifact) => artifact.platform === "linux-x64");
  if (!darwinArm64 || !linuxX64) {
    throw new Error("Homebrew formula requires darwin-arm64 and linux-x64 tar.gz artifacts");
  }
  return `class ${facts.package.formulaClass} < Formula
  desc "${rubyString(facts.package.desc)}"
  homepage "${rubyString(facts.package.homepage)}"
  version "${rubyString(facts.release.version)}"
  license "${rubyString(facts.package.license)}"

  if OS.mac? && Hardware::CPU.arm?
    url "${rubyString(darwinArm64.url)}"
    sha256 "${rubyString(darwinArm64.sha256)}"
  elsif OS.linux? && Hardware::CPU.intel?
    url "${rubyString(linuxX64.url)}"
    sha256 "${rubyString(linuxX64.sha256)}"
  else
    odie "${facts.package.formulaClass} Homebrew formula currently supports macOS arm64 and Linux x86_64 binary archives."
  end

  def install
    bin.install "${rubyString(facts.package.name)}"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/${rubyString(facts.package.name)} version")
  end
end
`;
}

function checkStatus(ok, id, message, details = {}) {
  return { id, status: ok ? "pass" : "fail", message, details };
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

export async function checkHomebrewTap({
  cwd = process.cwd(),
  packageName = "buildchain",
  releasePassport = "",
  manifestPath = DEFAULT_MANIFEST_PATH,
  formulaPath = "",
} = {}) {
  const facts = await collectHomebrewTapFacts({ cwd, packageName, releasePassport, manifestPath, formulaPath });
  const expectedFormula = renderHomebrewFormula(facts);
  const expectedManifest = facts.manifestProjection;
  const formulaFilePath = path.join(facts.cwd, facts.formula.path);
  const manifestFilePath = path.join(facts.cwd, facts.manifestPath);
  const currentFormula = fs.existsSync(formulaFilePath) ? fs.readFileSync(formulaFilePath, "utf8") : "";
  const currentManifest = readJsonFile(manifestFilePath, undefined);
  const formulaCurrent = currentFormula === expectedFormula;
  const manifestCurrent = currentManifest !== undefined && sameJson(currentManifest, expectedManifest);
  const checks = [
    checkStatus(facts.releasePassport.verified, "upstream-passport.verified", "upstream release passport verifies", {
      error: facts.releasePassport.verificationError,
    }),
    checkStatus((facts.formula.artifacts || []).length >= 2, "formula.artifacts", "formula has required platform artifacts", {
      platforms: (facts.formula.artifacts || []).map((artifact) => artifact.platform),
    }),
    checkStatus(formulaCurrent, "formula.current", "Formula is current with upstream passport projection", {
      path: facts.formula.path,
      expectedSha256: sha256Text(expectedFormula),
      actualSha256: currentFormula ? sha256Text(currentFormula) : "",
    }),
    checkStatus(manifestCurrent, "tap-manifest.current", "tap manifest is current with upstream passport projection", {
      path: facts.manifestPath,
      expectedSha256: sha256Text(`${JSON.stringify(expectedManifest, null, 2)}\n`),
      actualSha256: currentManifest ? sha256Text(`${JSON.stringify(currentManifest, null, 2)}\n`) : "",
    }),
    ...KFD_KEYS.map((key) => checkStatus(
      facts.kfd[key] === "passed",
      `kfd.${key}`,
      `${key} passed is backed by verified upstream release passport`,
      { status: facts.kfd[key] },
    )),
  ];
  return {
    schemaVersion: 1,
    contract: HOMEBREW_TAP_CHECK_CONTRACT,
    cwd: facts.cwd,
    ok: checks.every((check) => check.status === "pass"),
    package: packageName,
    checks,
    facts,
    expected: {
      formula: expectedFormula,
      manifest: expectedManifest,
    },
  };
}

export async function updateHomebrewTap({
  cwd = process.cwd(),
  packageName = "buildchain",
  releasePassport = "",
  manifestPath = DEFAULT_MANIFEST_PATH,
  formulaPath = "",
  write = true,
} = {}) {
  const facts = await collectHomebrewTapFacts({ cwd, packageName, releasePassport, manifestPath, formulaPath });
  const formula = renderHomebrewFormula(facts);
  const manifest = facts.manifestProjection;
  if (write) {
    writeTextFile(path.join(facts.cwd, facts.formula.path), formula);
    writeJsonFile(path.join(facts.cwd, facts.manifestPath), manifest);
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-homebrew-tap-update",
    ok: true,
    written: write ? [facts.formula.path, facts.manifestPath] : [],
    facts,
    formula,
    manifest,
  };
}
