import path from "node:path";
import fs from "node:fs";
import { readJsonFileIfExists, writeJsonFile } from "./passport-files.js";
import { spawnSyncCommand } from "../../../runtime/spawn-command.js";
import { npmPackageSpec } from "./publish-contract.js";
export function resolveMaybeRelative(cwd, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}
export function existingFiles(paths = [], cwd = process.cwd()) {
  return paths
    .map((filePath) => resolveMaybeRelative(cwd, filePath))
    .filter((filePath) => fs.existsSync(filePath));
}
export function platformManifestPathsFromBuildSummary(
  buildSummaryPath,
  cwd = process.cwd(),
) {
  const summary = readJsonFileIfExists(buildSummaryPath);
  if (!summary) {
    return [];
  }
  return (Array.isArray(summary.platforms) ? summary.platforms : [])
    .map((platform) => platform.manifestPath)
    .filter(Boolean)
    .map((manifestPath) => resolveMaybeRelative(cwd, manifestPath))
    .filter((manifestPath) => fs.existsSync(manifestPath));
}
export function packageSetFromArtifacts({
  artifacts = [],
  contract = {},
  registry = "https://registry.npmjs.org/",
} = {}) {
  if (
    !artifacts.length ||
    contract.packageSetOrder !== "platforms-first-main-last"
  ) {
    return undefined;
  }
  const normalized = artifacts.map((artifact) => ({
    name: artifact.name,
    version: artifact.ref || artifact.version || "",
    distTag: contract.distTag || "",
    digest: artifact.digest || "",
    registry,
    platform: artifact.platform || "",
    action: artifact.action || "",
  }));
  const mainPackage = contract.mainPackage || "";
  const mainIndex = normalized.findIndex(
    (artifact) => artifact.name === mainPackage,
  );
  if (mainIndex < 0) {
    return undefined;
  }
  const [main] = normalized.splice(mainIndex, 1);
  return {
    order: contract.packageSetOrder || "",
    registry,
    main,
    platforms: normalized,
  };
}
export function writeDistTagPromotionEvidence({
  evidencePath,
  mode,
  auth,
  distTag,
  source,
  artifacts = [],
}) {
  const outputPath = path.join(
    path.dirname(evidencePath),
    "dist-tag-evidence.json",
  );
  return writeJsonFile(outputPath, {
    schema: 1,
    contract: "kungfu-buildchain-dist-tag-promotion-evidence",
    mode,
    auth,
    distTag,
    source,
    packages: artifacts.map((artifact) => ({
      name: artifact.name,
      version: artifact.ref || artifact.version || "",
      distTag,
      role: artifact.role || "",
      digest: artifact.digest || "",
    })),
  });
}
export function findTransactionEvidencePath({
  cwd,
  transaction,
  fallbackName,
}) {
  for (const entry of transaction?.evidence || []) {
    const normalized = String(entry || "");
    if (normalized.endsWith(fallbackName)) {
      return path.resolve(cwd, normalized);
    }
  }
  return "";
}
export function npmTokenLooksConfigured() {
  return Boolean(
    process.env.NODE_AUTH_TOKEN ||
    process.env.NPM_TOKEN ||
    process.env.npm_config__authToken,
  );
}
export function execNpmSync(args, options) {
  const result = spawnSyncCommand("npm", args, options);
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    const error = new Error(`npm exited with status ${result.status ?? ""}`);
    error.status = result.status ?? 1;
    error.signal = result.signal || "";
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}
export function preflightNpmTokenAuth({
  cwd,
  registry = "https://registry.npmjs.org/",
} = {}) {
  if (!npmTokenLooksConfigured()) {
    throw new Error(
      "promote-existing-version requires npm token auth before dist-tag promotion; set NODE_AUTH_TOKEN or NPM_TOKEN",
    );
  }
  try {
    execNpmSync(["whoami", `--registry=${registry}`], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error.stderr?.toString?.().trim() || error.message;
    throw new Error(
      `promote-existing-version npm token preflight failed: npm whoami failed: ${message}`,
    );
  }
}
export function npmDistTagAlreadyPoints({ cwd, artifact, distTag }) {
  try {
    const output = execNpmSync(
      ["view", artifact.name, `dist-tags.${distTag}`, "--json"],
      {
        cwd,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (!output) {
      return false;
    }
    return JSON.parse(output) === artifact.ref;
  } catch {
    return false;
  }
}
export function promoteExistingNpmArtifacts({ cwd, artifacts, distTag }) {
  const promoted = new Set();
  for (const artifact of artifacts) {
    const spec = npmPackageSpec(artifact);
    const key = `${spec}\0${distTag}`;
    if (promoted.has(key)) {
      continue;
    }
    if (npmDistTagAlreadyPoints({ cwd, artifact, distTag })) {
      promoted.add(key);
      continue;
    }
    execNpmSync(["dist-tag", "add", spec, distTag], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    promoted.add(key);
  }
  return "existing-npm-artifacts";
}
