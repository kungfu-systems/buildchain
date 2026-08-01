import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadBuildchainConfig } from "./buildchain-config.js";

export const PAPER_PATHS = Object.freeze({
  config: ".buildchain/buildchain.toml",
  agentEntry: ".buildchain/paper/agent-entry.json",
  agentInstructions: "AGENTS.md",
  versionPin: ".buildchain-version",
  contractLock: ".buildchain/contract-lock.json",
  buildWorkflow: ".github/workflows/build.yml",
  verifyWorkflow: ".github/workflows/verify.yml",
  releaseWorkflow: ".github/workflows/paper-release.yml",
  reproducibilityReceipt:
    ".buildchain/publication/reproducibility-receipt.json",
  sealedBundle: ".buildchain/admitted/sealed-bundle.json",
  admission: ".buildchain/admitted/publication-admission.json",
  capability: ".buildchain/admitted/publication-capability.json",
  npmBootstrap: ".buildchain/paper/npm-bootstrap.json",
  npmTrust: ".buildchain/paper/npm-trust.json",
  provisioningAuthority: ".buildchain/paper/provisioning-authority.json",
  visibility: ".buildchain/paper/visibility.json",
});

export const PAPER_WORK_BRANCH_PATTERN =
  /^(?:feature|fix|docs|chore|ci|refactor)\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

export function readJson(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { exists: false, value: undefined, error: "" };
  }
  try {
    return {
      exists: true,
      value: JSON.parse(fs.readFileSync(filePath, "utf8")),
      error: "",
    };
  } catch (error) {
    return { exists: true, value: undefined, error: error.message };
  }
}

export function normalizeRepository(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)
    ? normalized
    : "";
}

export function commandResult(
  command,
  args,
  { cwd, env = process.env, timeout = 15000 } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || "",
  };
}

export function gitResult(cwd, args) {
  return commandResult("git", args, { cwd });
}

export function gitValue(cwd, args) {
  const result = gitResult(cwd, args);
  return result.ok ? result.stdout : "";
}

export function paperConfig(cwd) {
  const loaded = loadBuildchainConfig(cwd);
  if (!loaded)
    return { loaded: undefined, error: `${PAPER_PATHS.config} is missing` };
  if (loaded.config.project?.type !== "publication-artifact") {
    return { loaded, error: 'project.type must be "publication-artifact"' };
  }
  if (!loaded.config.publication)
    return { loaded, error: "[publication] is missing" };
  return { loaded, error: "" };
}

export function parsePaperVersion(version) {
  const normalized = String(version || "")
    .trim()
    .replace(/^v/, "");
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match)
    throw new Error("publication.version must be semver before planning Alpha");
  return {
    version: normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
  };
}

export function resolvePaperRepository(cwd = process.cwd()) {
  const sourcePackage = readJson(path.resolve(cwd, "package.json")).value;
  const configured =
    typeof sourcePackage?.repository === "string"
      ? sourcePackage.repository
      : sourcePackage?.repository?.url;
  return (
    normalizeRepository(configured) ||
    normalizeRepository(gitValue(cwd, ["config", "--get", "remote.origin.url"]))
  );
}

export function paperDevelopmentRef(cwd) {
  const configResult = paperConfig(cwd);
  if (configResult.error) throw new Error(configResult.error);
  const parsed = parsePaperVersion(
    configResult.loaded.config.publication.version,
  );
  return `dev/v${parsed.major}/v${parsed.major}.${parsed.minor}`;
}

export function remoteBranchObservation(cwd, branch) {
  const result = gitResult(cwd, [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ]);
  const sha = result.stdout.split(/\s+/)[0] || "";
  return {
    observed: result.ok,
    ok: result.ok && /^[0-9a-f]{40}$/i.test(sha),
    sha: /^[0-9a-f]{40}$/i.test(sha) ? sha : "",
    error: result.error || result.stderr,
  };
}

export function paperWorkSource(cwd) {
  const repository = resolvePaperRepository(cwd);
  const remotes = gitValue(cwd, ["remote"]).split(/\s+/).filter(Boolean).sort();
  const originUrl = gitValue(cwd, ["config", "--get", "remote.origin.url"]);
  const originRepository = normalizeRepository(originUrl);
  return {
    repository,
    remotes,
    originUrl,
    originRepository,
    canonical:
      remotes.length === 1 &&
      remotes[0] === "origin" &&
      Boolean(repository) &&
      repository === originRepository &&
      repository.startsWith("kungfu-systems/"),
    branch: gitValue(cwd, ["branch", "--show-current"]),
    head: gitValue(cwd, ["rev-parse", "HEAD"]),
    clean: gitResult(cwd, ["status", "--porcelain"]).stdout === "",
  };
}

export function rootedPlan(payload) {
  return { ...payload, planRoot: sha256Text(stableJson(payload)) };
}

export function workCheck(id, ok, message, correctiveCommand = "") {
  return {
    id,
    status: ok ? "pass" : "fail",
    message,
    correctiveCommand: ok ? "" : correctiveCommand,
  };
}

export function normalizedWorkBranch(topic, explicitBranch = "") {
  const candidate = explicitBranch
    ? String(explicitBranch).trim()
    : `feature/${String(topic || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/g, "-")
        .replace(/^-+|-+$/g, "")}`;
  return PAPER_WORK_BRANCH_PATTERN.test(candidate) ? candidate : "";
}
