import crypto from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadBuildchainConfig } from "./buildchain-config.js";

export const BUILD_FACTS_GIT_CONTRACT = "kungfu-buildchain-git-source-facts";
export const BUILD_FACTS_VERSION_CONTRACT = "kungfu-buildchain-version-source-facts";
export const BUILD_FACTS_MODULE_CONTRACT = "kungfu-buildchain-module-build-facts";
export const BUILD_FACTS_PRODUCT_CONTRACT = "kungfu-buildchain-product-build-facts";
export const BUILD_FACTS_VERIFY_CONTRACT = "kungfu-buildchain-build-facts-verification";
export const BUILD_FACTS_LEGACY_KUNGFU_BUILDINFO_CONTRACT = "kungfu-buildchain-legacy-kungfu-buildinfo-projection";

function nowIso() {
  return new Date().toISOString();
}

function posixPath(value) {
  return String(value || "").split(path.sep).join("/");
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

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function buildFactsDigest(value) {
  return `sha256:${sha256Text(stableJson(value))}`;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function git(cwd, args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function parseZeroSeparated(input) {
  return String(input || "").split("\0").filter(Boolean);
}

function repositorySlug(cwd) {
  const remote = git(cwd, ["config", "--get", "remote.origin.url"]);
  const match = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : "";
}

function readTrackedFiles(cwd, root = ".") {
  const repoRoot = fs.realpathSync(path.resolve(cwd));
  const requestedRoot = fs.realpathSync(path.resolve(cwd, root));
  const relativeRoot = posixPath(path.relative(repoRoot, requestedRoot) || ".");
  const args = relativeRoot === "." ? ["ls-files", "-z"] : ["ls-files", "-z", "--", relativeRoot];
  return parseZeroSeparated(git(repoRoot, args))
    .filter((entry) => entry && !entry.startsWith(".git/"))
    .sort();
}

function digestTrackedFiles(cwd, root = ".") {
  const repoRoot = fs.realpathSync(path.resolve(cwd));
  const hash = crypto.createHash("sha256");
  const files = readTrackedFiles(repoRoot, root);
  for (const file of files) {
    const filePath = path.resolve(repoRoot, file);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      continue;
    }
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return {
    algorithm: "sha256",
    value: hash.digest("hex"),
    fileCount: files.length,
    scope: posixPath(root || "."),
  };
}

function readByDottedKey(value, key) {
  return String(key || "").split(".").reduce((current, segment) => current?.[segment], value);
}

function normalizeVersionSource(source = {}, fallbackId = "version") {
  if (typeof source === "string") {
    return { id: fallbackId, type: "static", value: source };
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { id: fallbackId, type: "none" };
  }
  return {
    id: String(source.id || source.name || fallbackId),
    type: String(source.type || "static"),
    value: source.value,
    path: source.path ? posixPath(source.path) : "",
    key: source.key ? String(source.key) : "",
    pattern: source.pattern ? String(source.pattern) : "",
    command: source.command ? String(source.command) : "",
    trust: source.trust ? String(source.trust) : "",
    reproducible: source.reproducible === undefined ? undefined : Boolean(source.reproducible),
  };
}

function resolveConfiguredVersionSource({ cwd, sourceId = "" } = {}) {
  const loaded = loadBuildchainConfig(cwd);
  const configured = loaded?.config?.facts?.versionSources || [];
  if (sourceId) {
    return configured.find((source) => source.id === sourceId);
  }
  return configured[0];
}

export function collectGitSourceFacts({ cwd = process.cwd(), root = "." } = {}) {
  const resolvedCwd = fs.realpathSync(path.resolve(cwd));
  const repoRoot = fs.realpathSync(git(resolvedCwd, ["rev-parse", "--show-toplevel"], resolvedCwd));
  const digest = digestTrackedFiles(repoRoot, path.resolve(resolvedCwd, root));
  const status = git(repoRoot, ["status", "--porcelain=v1"]);
  const branch = git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const headSha = git(repoRoot, ["rev-parse", "HEAD"]);
  const tags = git(repoRoot, ["tag", "--points-at", "HEAD"])
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    schemaVersion: 1,
    contract: BUILD_FACTS_GIT_CONTRACT,
    repositoryRoot: repoRoot,
    repository: repositorySlug(repoRoot),
    headSha,
    branch,
    refName: process.env.GITHUB_REF_NAME || branch || "",
    ref: process.env.GITHUB_REF || "",
    tags,
    dirty: status.length > 0,
    pristine: status.length === 0,
    sourceDigest: digest,
  };
}

export function collectVersionSourceFact({ cwd = process.cwd(), source = undefined, sourceId = "", now = nowIso() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const normalized = normalizeVersionSource(source || resolveConfiguredVersionSource({ cwd: resolvedCwd, sourceId }));
  const fact = {
    schemaVersion: 1,
    contract: BUILD_FACTS_VERSION_CONTRACT,
    id: normalized.id,
    type: normalized.type,
    generatedAt: now,
    value: "",
    source: {
      path: normalized.path,
      key: normalized.key,
      pattern: normalized.pattern,
      command: normalized.command,
      trust: normalized.trust || (normalized.type === "command" ? "explicit-command-output" : "declared-source"),
      reproducible: normalized.reproducible ?? normalized.type !== "command",
    },
    sourceDigest: "",
    extraction: {
      method: normalized.type,
      ok: false,
      error: "",
    },
  };
  try {
    if (normalized.type === "static") {
      fact.value = String(normalized.value || "");
      fact.sourceDigest = `sha256:${sha256Text(fact.value)}`;
    } else if (["json", "toml", "regex"].includes(normalized.type)) {
      const filePath = path.resolve(resolvedCwd, normalized.path);
      const sourceText = fs.readFileSync(filePath, "utf8");
      fact.sourceDigest = `sha256:${sha256Text(sourceText)}`;
      if (normalized.type === "json") {
        fact.value = String(readByDottedKey(JSON.parse(sourceText), normalized.key) || "");
      } else if (normalized.type === "toml") {
        fact.value = String(readByDottedKey(parseToml(sourceText), normalized.key) || "");
      } else {
        const match = sourceText.match(new RegExp(normalized.pattern, "m"));
        fact.value = String(match?.groups?.version || match?.[1] || "");
      }
    } else if (normalized.type === "command") {
      fact.value = execSync(normalized.command, {
        cwd: resolvedCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      fact.sourceDigest = `sha256:${sha256Text(`${normalized.command}\n${fact.value}`)}`;
    } else if (normalized.type === "none") {
      fact.extraction.error = "no version source declared";
    } else {
      throw new Error(`unsupported version source type: ${normalized.type}`);
    }
    if (fact.value) {
      fact.extraction.ok = true;
    } else if (!fact.extraction.error) {
      fact.extraction.error = "version source produced an empty value";
    }
  } catch (error) {
    fact.extraction.ok = false;
    fact.extraction.error = error.message;
  }
  return fact;
}

function digestOutputPath(cwd, relativePath) {
  const absolutePath = path.resolve(cwd, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      path: posixPath(relativePath),
      exists: false,
      digest: "",
      size: 0,
      kind: "missing",
    };
  }
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (entry.isFile()) {
          files.push(posixPath(path.relative(absolutePath, entryPath)));
        }
      }
    };
    walk(absolutePath);
    files.sort();
    const hash = crypto.createHash("sha256");
    let totalSize = 0;
    for (const file of files) {
      const filePath = path.join(absolutePath, file);
      totalSize += fs.statSync(filePath).size;
      hash.update(file);
      hash.update("\0");
      hash.update(fs.readFileSync(filePath));
      hash.update("\0");
    }
    return {
      path: posixPath(relativePath),
      exists: true,
      digest: `sha256:${hash.digest("hex")}`,
      size: totalSize,
      kind: "directory",
      fileCount: files.length,
    };
  }
  return {
    path: posixPath(relativePath),
    exists: true,
    digest: `sha256:${sha256File(absolutePath)}`,
    size: stat.size,
    kind: "file",
  };
}

function currentPlatform() {
  return `${process.platform}-${process.arch}`;
}

function configuredModule({ cwd, moduleId }) {
  const loaded = loadBuildchainConfig(cwd);
  const modules = loaded?.config?.facts?.modules || [];
  return modules.find((entry) => entry.id === moduleId) || modules[0] || {};
}

export function collectModuleBuildFacts({
  cwd = process.cwd(),
  moduleId = "",
  moduleRoot = "",
  scope = "",
  versionSource = undefined,
  versionSourceId = "",
  outputs = [],
  lifecycle = "",
  platform = currentPlatform(),
  dependencies = [],
  now = nowIso(),
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const configured = configuredModule({ cwd: resolvedCwd, moduleId });
  const id = moduleId || configured.id || "module";
  const root = moduleRoot || configured.root || ".";
  const outputPaths = outputs.length ? outputs : configured.outputs || [];
  const versionFact = collectVersionSourceFact({
    cwd: resolvedCwd,
    source: versionSource,
    sourceId: versionSourceId || configured.versionSource || "",
    now,
  });
  const fact = {
    schemaVersion: 1,
    contract: BUILD_FACTS_MODULE_CONTRACT,
    id,
    kind: "module",
    generatedAt: now,
    cwd: resolvedCwd,
    moduleRoot: posixPath(root),
    scope: scope || configured.scope || id,
    git: collectGitSourceFacts({ cwd: resolvedCwd, root }),
    version: versionFact,
    lifecycle: {
      invocation: lifecycle || configured.lifecycle || "",
    },
    platform,
    runtime: {
      node: process.version,
      os: os.type(),
      osRelease: os.release(),
      arch: os.arch(),
    },
    outputs: outputPaths.map((entry) => digestOutputPath(resolvedCwd, entry)),
    dependencies: dependencies.map((entry) => String(entry)),
    verification: {
      ok: false,
      status: "unknown",
      issues: [],
    },
  };
  fact.digest = buildFactsDigest({ ...fact, digest: undefined, verification: undefined });
  fact.verification = verifyBuildFacts({ cwd: resolvedCwd, fact }).summary;
  return fact;
}

function readFact(input) {
  if (typeof input === "string") {
    return readJsonFile(input);
  }
  return input;
}

function verifyModuleFact({ cwd, fact }) {
  const issues = [];
  if (fact.contract !== BUILD_FACTS_MODULE_CONTRACT) {
    issues.push({ level: "error", id: "contract", message: "module fact contract is invalid" });
  }
  if (!fact.id) {
    issues.push({ level: "error", id: "module.id", message: "module fact id is required" });
  }
  if (!fact.version?.extraction?.ok) {
    issues.push({ level: "error", id: "version", message: fact.version?.extraction?.error || "version source is invalid" });
  }
  const gitFacts = collectGitSourceFacts({ cwd, root: fact.moduleRoot || "." });
  if (fact.git?.headSha && gitFacts.headSha && fact.git.headSha !== gitFacts.headSha) {
    issues.push({ level: "error", id: "git.headSha", message: "module fact was collected from a different HEAD" });
  }
  if (fact.git?.sourceDigest?.value && gitFacts.sourceDigest?.value && fact.git.sourceDigest.value !== gitFacts.sourceDigest.value) {
    issues.push({ level: "error", id: "git.sourceDigest", message: "module source digest is stale" });
  }
  for (const output of fact.outputs || []) {
    const current = digestOutputPath(cwd, output.path);
    if (!current.exists) {
      issues.push({ level: "error", id: `output.${output.path}`, message: "declared module output is missing" });
    } else if (output.digest && current.digest !== output.digest) {
      issues.push({ level: "error", id: `output.${output.path}`, message: "declared module output digest is stale" });
    }
  }
  return issues;
}

function verifyProductFact({ cwd, fact }) {
  const issues = [];
  if (fact.contract !== BUILD_FACTS_PRODUCT_CONTRACT) {
    issues.push({ level: "error", id: "contract", message: "product fact contract is invalid" });
  }
  if (!fact.id) {
    issues.push({ level: "error", id: "product.id", message: "product fact id is required" });
  }
  for (const module of fact.modules || []) {
    if (!module.digest) {
      issues.push({ level: "error", id: `module.${module.id || "unknown"}`, message: "product module reference is missing digest" });
    }
    if (module.verificationStatus !== "passed") {
      issues.push({ level: "error", id: `module.${module.id || "unknown"}.verification`, message: module.verificationReason || "module fact did not verify" });
    }
  }
  for (const artifact of fact.artifacts || []) {
    const current = digestOutputPath(cwd, artifact.path);
    if (!current.exists) {
      issues.push({ level: "error", id: `artifact.${artifact.path}`, message: "declared product artifact is missing" });
    } else if (artifact.digest && current.digest !== artifact.digest) {
      issues.push({ level: "error", id: `artifact.${artifact.path}`, message: "declared product artifact digest is stale" });
    }
  }
  return issues;
}

export function verifyBuildFacts({ cwd = process.cwd(), fact, factPath = "" } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedFact = fact || readJsonFile(path.resolve(resolvedCwd, factPath));
  const issues = resolvedFact.contract === BUILD_FACTS_MODULE_CONTRACT
    ? verifyModuleFact({ cwd: resolvedCwd, fact: resolvedFact })
    : resolvedFact.contract === BUILD_FACTS_PRODUCT_CONTRACT
      ? verifyProductFact({ cwd: resolvedCwd, fact: resolvedFact })
      : [{ level: "error", id: "contract", message: `unsupported build facts contract: ${resolvedFact.contract || "<missing>"}` }];
  const ok = issues.filter((issue) => issue.level === "error").length === 0;
  return {
    schemaVersion: 1,
    contract: BUILD_FACTS_VERIFY_CONTRACT,
    ok,
    status: ok ? "passed" : "failed",
    checkedAt: nowIso(),
    summary: {
      ok,
      status: ok ? "passed" : "failed",
      issues,
    },
    fact: {
      contract: resolvedFact.contract,
      id: resolvedFact.id || "",
      digest: resolvedFact.digest || buildFactsDigest(resolvedFact),
    },
    issues,
  };
}

function configuredProduct({ cwd, productId }) {
  const loaded = loadBuildchainConfig(cwd);
  const products = loaded?.config?.facts?.products || [];
  return products.find((entry) => entry.id === productId) || products[0] || {};
}

export function aggregateBuildFacts({
  cwd = process.cwd(),
  productId = "",
  moduleFacts = [],
  artifacts = [],
  now = nowIso(),
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const configured = configuredProduct({ cwd: resolvedCwd, productId });
  const moduleInputs = moduleFacts.length ? moduleFacts : configured.moduleFacts || [];
  const artifactInputs = artifacts.length ? artifacts : configured.artifacts || [];
  const modules = moduleInputs.map((input) => {
    const factPath = typeof input === "string" ? path.resolve(resolvedCwd, input) : "";
    const fact = readFact(factPath || input);
    const verification = verifyBuildFacts({ cwd: resolvedCwd, fact });
    return {
      id: fact.id || "",
      contract: fact.contract || "",
      path: factPath ? posixPath(path.relative(resolvedCwd, factPath)) : "",
      digest: fact.digest || buildFactsDigest(fact),
      version: fact.version?.value || "",
      gitHeadSha: fact.git?.headSha || "",
      verificationStatus: verification.status,
      verificationReason: verification.issues.map((issue) => issue.message).join("; "),
    };
  });
  const fact = {
    schemaVersion: 1,
    contract: BUILD_FACTS_PRODUCT_CONTRACT,
    id: productId || configured.id || "product",
    kind: "product",
    generatedAt: now,
    cwd: resolvedCwd,
    git: collectGitSourceFacts({ cwd: resolvedCwd }),
    modules,
    artifacts: artifactInputs.map((entry) => digestOutputPath(resolvedCwd, entry)),
    verification: {
      ok: false,
      status: "unknown",
      issues: [],
    },
  };
  fact.digest = buildFactsDigest({ ...fact, digest: undefined, verification: undefined });
  fact.verification = verifyBuildFacts({ cwd: resolvedCwd, fact }).summary;
  return fact;
}

function collectPythonVersion(cwd) {
  for (const command of ["python3 --version", "python --version"]) {
    try {
      return execSync(command, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim().replace(/^Python\s+/, "");
    } catch {
      // best effort legacy compatibility field
    }
  }
  return "";
}

export function createKungfuBuildInfoProjection({ moduleFact, cwd = process.cwd(), now = nowIso() } = {}) {
  const fact = readFact(moduleFact);
  return {
    schemaVersion: 1,
    contract: BUILD_FACTS_LEGACY_KUNGFU_BUILDINFO_CONTRACT,
    generatedAt: now,
    source: {
      contract: fact.contract,
      moduleId: fact.id,
      digest: fact.digest || buildFactsDigest(fact),
    },
    version: fact.version?.value || "",
    python_version: collectPythonVersion(cwd),
    build_user: os.userInfo().username,
    build_os: `${os.type()} ${os.release()} ${os.arch()}`,
    build_timestamp: now,
    git_tag: fact.git?.tags?.[0] || "",
    git_branch: fact.git?.branch || fact.git?.refName || "",
    git_revision: fact.git?.headSha || "",
    git_pristine: Boolean(fact.git?.pristine),
    buildchain: {
      contract: fact.contract,
      moduleFactDigest: fact.digest || buildFactsDigest(fact),
      versionSourceDigest: fact.version?.sourceDigest || "",
      sourceDigest: fact.git?.sourceDigest?.value ? `sha256:${fact.git.sourceDigest.value}` : "",
    },
  };
}

export function writeBuildFacts({ cwd = process.cwd(), fact, output = "" } = {}) {
  const resolvedOutput = output || path.join(cwd, ".buildchain", "facts", `${fact.id || "build-facts"}.json`);
  return {
    path: writeJsonFile(path.resolve(cwd, resolvedOutput), fact),
    digest: buildFactsDigest(fact),
  };
}

export function writeKungfuBuildInfoProjection({ cwd = process.cwd(), moduleFact, output } = {}) {
  if (!output) {
    throw new Error("legacy Kungfu buildinfo projection requires output");
  }
  const projection = createKungfuBuildInfoProjection({ cwd, moduleFact });
  return {
    projection,
    path: writeJsonFile(path.resolve(cwd, output), projection),
    digest: buildFactsDigest(projection),
  };
}
