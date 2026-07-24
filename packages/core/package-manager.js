import fs from "node:fs";
import path from "node:path";

const KNOWN_MANAGERS = new Set(["pnpm", "yarn", "npm"]);

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parsePackageManager(value) {
  const match = String(value || "").match(/^(pnpm|yarn|npm)(?:@|$)/);
  return match ? match[1] : null;
}

export function validatePackageManagerContract({ cwd = process.cwd(), expectedManager = "" } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const pkg = readJsonIfExists(path.join(resolvedCwd, "package.json"));
  const declaredSpec = String(pkg?.packageManager || "").trim();
  const declaredMatch = declaredSpec.match(/^([A-Za-z0-9._-]+)@([^\s]+)$/);

  if (declaredSpec && !declaredMatch) {
    throw new Error(
      `Invalid packageManager declaration: ${declaredSpec}. Expected <manager>@<version>.`,
    );
  }

  const declaredName = declaredMatch?.[1] || "";
  const detected = declaredName && !KNOWN_MANAGERS.has(declaredName)
    ? { name: "custom", reason: "packageManager" }
    : detectPackageManager(resolvedCwd);
  const expected = String(expectedManager || "").trim();
  if (expected && expected !== "custom" && detected.name !== expected) {
    throw new Error(
      `Package manager mismatch: workflow requested ${expected}, but the consumer declares ${detected.name}.`,
    );
  }

  return {
    name: detected.name,
    reason: detected.reason,
    declaredSpec,
    declaredVersion: declaredMatch?.[2] || "",
  };
}

export function assertPackageManager(manager) {
  if (!KNOWN_MANAGERS.has(manager)) {
    throw new Error(`Unsupported package manager: ${manager}`);
  }
  return manager;
}

export function detectPackageManager(cwd = process.cwd()) {
  const envValue = process.env.BUILDCHAIN_PACKAGE_MANAGER;
  const envManager = parsePackageManager(envValue);
  if (envValue && !envManager) {
    throw new Error(`Unsupported package manager from BUILDCHAIN_PACKAGE_MANAGER: ${envValue}`);
  }
  if (envManager) {
    return { name: envManager, reason: "BUILDCHAIN_PACKAGE_MANAGER" };
  }

  const pkg = readJsonIfExists(path.join(cwd, "package.json"));
  const declared = parsePackageManager(pkg?.packageManager);
  if (declared) {
    return { name: declared, reason: "packageManager", packageManager: pkg.packageManager };
  }

  const lockfiles = [
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["npm", "package-lock.json"],
    ["npm", "npm-shrinkwrap.json"],
  ];
  for (const [name, lockfile] of lockfiles) {
    if (fs.existsSync(path.join(cwd, lockfile))) {
      return { name, reason: "lockfile", lockfile };
    }
  }

  throw new Error(
    "Unable to detect package manager. Add packageManager to package.json or commit a supported lockfile.",
  );
}

export function commandForRunScript(manager, script) {
  assertPackageManager(manager);
  if (manager === "pnpm") {
    return { cmd: "pnpm", args: ["run", script] };
  }
  if (manager === "npm") {
    return { cmd: "npm", args: ["run", script] };
  }
  return { cmd: "yarn", args: ["run", script] };
}

export function commandForVersion(manager, keyword, options = {}) {
  assertPackageManager(manager);
  const args = [];
  if (manager === "yarn") {
    args.push("version", `--${keyword}`);
  } else {
    args.push("version", keyword);
  }
  args.push(...(options.preid ? ["--preid", options.preid] : []));
  args.push(...(options.message ? ["--message", options.message] : []));
  args.push(...(options.tag === false ? ["--no-git-tag-version"] : []));
  return { cmd: manager, args };
}

export function shellJoin(command) {
  return [command.cmd, ...command.args].map((part) => {
    const value = String(part);
    return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : JSON.stringify(value);
  }).join(" ");
}

export function commandForKungfuUpgrade(manager, scope = "@kungfu-trader") {
  assertPackageManager(manager);
  if (manager === "pnpm") {
    return {
      primary: shellJoin({
        cmd: "pnpm",
        args: ["update", "--recursive", "--filter", `${scope}/*`, "--ignore-scripts"],
      }),
      fallback: "pnpm install --ignore-scripts --lockfile-only",
    };
  }
  if (manager === "npm") {
    return {
      primary: shellJoin({ cmd: "npm", args: ["update", "--workspaces", "--ignore-scripts"] }),
      fallback: "npm install --ignore-scripts --package-lock-only --dry-run",
    };
  }
  return {
    primary: shellJoin({ cmd: "yarn", args: ["upgrade", "--scope", scope, "--ignore-scripts"] }),
    fallback: shellJoin({ cmd: "yarn", args: ["install", "-scope", scope, "--ignore-scripts", "--force", "--dry-run"] }),
  };
}

function normalizeWorkspacePatterns(config) {
  if (!config) {
    return [];
  }
  if (Array.isArray(config.workspaces)) {
    return config.workspaces;
  }
  if (Array.isArray(config.workspaces?.packages)) {
    return config.workspaces.packages;
  }
  if (Array.isArray(config.packages)) {
    return config.packages;
  }
  return [];
}

function readPnpmWorkspacePatterns(cwd) {
  const filePath = path.join(cwd, "pnpm-workspace.yaml");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const patterns = [];
  let inPackages = false;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) {
      break;
    }
    const match = inPackages && line.match(/^\s*-\s*["']?([^"']+)["']?\s*$/);
    if (match) {
      patterns.push(match[1]);
    }
  }
  return patterns;
}

function posixRelative(cwd, item) {
  return path.relative(cwd, item).split(path.sep).join("/");
}

function expandWorkspacePattern(cwd, pattern) {
  if (!pattern || pattern.startsWith("!")) {
    return [];
  }
  const normalized = pattern.replace(/\/package\.json$/, "");
  const parts = normalized.split("/");
  const wildcardIndex = parts.indexOf("*");
  if (wildcardIndex === -1) {
    const packageJson = path.join(cwd, normalized, "package.json");
    return fs.existsSync(packageJson) ? [path.dirname(packageJson)] : [];
  }
  const prefix = parts.slice(0, wildcardIndex).join("/");
  const suffix = parts.slice(wildcardIndex + 1).join("/");
  const baseDir = path.join(cwd, prefix);
  if (!fs.existsSync(baseDir)) {
    return [];
  }
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name, suffix))
    .filter((dir) => fs.existsSync(path.join(dir, "package.json")));
}

export function getWorkspaceInfo(cwd = process.cwd()) {
  const packageConfig = readJsonIfExists(path.join(cwd, "package.json"));
  const lernaConfig = readJsonIfExists(path.join(cwd, "lerna.json"));
  const patterns = [
    ...normalizeWorkspacePatterns(packageConfig),
    ...normalizeWorkspacePatterns(lernaConfig),
    ...readPnpmWorkspacePatterns(cwd),
  ];
  const info = {};
  const seen = new Set();
  for (const pattern of patterns) {
    for (const packageDir of expandWorkspacePattern(cwd, pattern)) {
      const location = posixRelative(cwd, packageDir);
      if (seen.has(location)) {
        continue;
      }
      seen.add(location);
      const config = readJsonIfExists(path.join(packageDir, "package.json"));
      if (config?.name) {
        info[config.name] = { location };
      }
    }
  }
  return info;
}

export function detectLockfile(cwd = process.cwd()) {
  for (const lockfile of ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json"]) {
    const filePath = path.join(cwd, lockfile);
    if (fs.existsSync(filePath)) {
      return { lockfile, filePath };
    }
  }
  return null;
}

function mapSetIfKungfu(acc, name, version) {
  if (name && version && name.startsWith("@kungfu-trader/")) {
    acc.set(name, version);
  }
}

export function getYarnLockInfo(content) {
  if (!content) {
    return undefined;
  }
  const acc = new Map();
  for (const block of content.split(/\n(?=\S)/)) {
    const header = block.split(/\r?\n/, 1)[0] || "";
    const nameMatch = header.match(/@kungfu-trader\/([^@,\s:"]+)/);
    const versionMatch = block.match(/^\s+version\s+"?([^"\s]+)"?/m);
    mapSetIfKungfu(acc, nameMatch && `@kungfu-trader/${nameMatch[1]}`, versionMatch?.[1]);
  }
  return acc;
}

export function getPnpmLockInfo(content) {
  const acc = new Map();
  const pattern = /@kungfu-trader\/([^@\s:'")]+)@([^:\s'")]+)/g;
  for (const match of content.matchAll(pattern)) {
    mapSetIfKungfu(acc, `@kungfu-trader/${match[1]}`, match[2].split("(")[0]);
  }
  return acc;
}

function visitNpmDependencyTree(acc, deps = {}) {
  for (const [name, value] of Object.entries(deps || {})) {
    mapSetIfKungfu(acc, name, value?.version);
    visitNpmDependencyTree(acc, value?.dependencies);
  }
}

export function getNpmLockInfo(content) {
  const json = JSON.parse(content);
  const acc = new Map();
  for (const [key, value] of Object.entries(json.packages || {})) {
    const match = key.match(/node_modules\/(@kungfu-trader\/[^/]+)$/);
    mapSetIfKungfu(acc, match?.[1], value?.version);
  }
  visitNpmDependencyTree(acc, json.dependencies);
  return acc;
}

export function getCurrentLockInfo(cwd = process.cwd()) {
  const found = detectLockfile(cwd);
  if (!found) {
    return undefined;
  }
  const content = fs.readFileSync(found.filePath, "utf8");
  if (found.lockfile === "yarn.lock") {
    return getYarnLockInfo(content);
  }
  if (found.lockfile === "pnpm-lock.yaml") {
    return getPnpmLockInfo(content);
  }
  return getNpmLockInfo(content);
}

export default {
  assertPackageManager,
  commandForKungfuUpgrade,
  commandForRunScript,
  commandForVersion,
  detectLockfile,
  detectPackageManager,
  getCurrentLockInfo,
  getNpmLockInfo,
  getPnpmLockInfo,
  getWorkspaceInfo,
  getYarnLockInfo,
  shellJoin,
  validatePackageManagerContract,
};
