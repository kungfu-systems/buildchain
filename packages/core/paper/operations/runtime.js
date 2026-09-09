import { PACKAGE_PATTERN, GIT_SHA_PATTERN, NPM_REGISTRY } from "./identity.js";
import { readJson, gitValue, commandResult } from "../paper-repository.js";
import path from "node:path";
import { resolvePaperBuildchainSha } from "../paper-agent-entry.js";
import { resolvePaperNpmRuntimeSha } from "../paper-runtime-channels.js";
import { safeParseJson } from "./files.js";
import { createBuildchainContractWorld } from "../../contracts/buildchain-contract.js";
import fs from "node:fs";
export function normalizePackageName(value, label = "package name") {
  const normalized = String(value || "").trim();
  if (!PACKAGE_PATTERN.test(normalized) || normalized.length > 214) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}
export function buildchainPackageIdentity(
  buildchainRoot,
  explicitVersion = "",
) {
  const packageJson = readJson(
    path.resolve(buildchainRoot, "package.json"),
  ).value;
  return {
    name: String(packageJson?.name || "@kungfu-tech/buildchain"),
    version: String(explicitVersion || packageJson?.version || ""),
  };
}
export function resolvePaperRuntimeGitSha(
  buildchainRoot,
  buildchainVersion = "",
) {
  const value = resolvePaperBuildchainSha(buildchainRoot);
  if (GIT_SHA_PATTERN.test(value)) return value;
  const identity = buildchainPackageIdentity(buildchainRoot, buildchainVersion);
  return resolvePaperNpmRuntimeSha(buildchainRoot, identity);
}
export function runtimeAcceptedAt(buildchainRoot, sha, buildchainVersion = "") {
  if (!sha) return "1970-01-01T00:00:00.000Z";
  const value = gitValue(buildchainRoot, ["show", "-s", "--format=%cI", sha]);
  let acceptedAt = value;
  if (!acceptedAt && buildchainVersion) {
    const identity = buildchainPackageIdentity(
      buildchainRoot,
      buildchainVersion,
    );
    const observed = commandResult(
      "npm",
      [
        "view",
        `${identity.name}@${identity.version}`,
        "time",
        "--json",
        `--registry=${NPM_REGISTRY}`,
      ],
      { cwd: buildchainRoot },
    );
    const published = observed.ok ? safeParseJson(observed.stdout) : null;
    acceptedAt = String(published?.[identity.version] || "");
  }
  const parsed = new Date(acceptedAt);
  return Number.isNaN(parsed.valueOf())
    ? "1970-01-01T00:00:00.000Z"
    : parsed.toISOString();
}
export function runtimeContractWorld(buildchainRoot) {
  const embedded = String(process.env.BUILDCHAIN_EMBEDDED_CONTRACT_WORLD || "");
  if (embedded) {
    const parsed = safeParseJson(embedded);
    if (parsed?.contract) return parsed;
    throw new Error("embedded Buildchain contract world is invalid");
  }
  return createBuildchainContractWorld({ root: buildchainRoot });
}
export function runtimeLicenseText(buildchainRoot) {
  const licensePath = path.join(buildchainRoot, "LICENSE");
  if (fs.existsSync(licensePath) && fs.statSync(licensePath).isFile()) {
    return fs.readFileSync(licensePath, "utf8");
  }
  const embedded = String(process.env.BUILDCHAIN_EMBEDDED_LICENSE_TEXT || "");
  if (embedded) return embedded;
  throw new Error(
    "Buildchain package is missing LICENSE; cannot create a governed paper scaffold",
  );
}
