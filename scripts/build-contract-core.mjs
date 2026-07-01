import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNNER_PRESETS = Object.freeze({
  "github-hosted": [
    { id: "linux-x64", name: "Linux x64", runner: "[\"ubuntu-24.04\"]" },
    { id: "macos", name: "macOS", runner: "[\"macos-latest\"]" },
    { id: "windows-x64", name: "Windows x64", runner: "[\"windows-2022\"]" },
  ],
  "kungfu-v4-self-hosted": [
    {
      id: "linux-x64",
      name: "Linux x64",
      runner: "[\"self-hosted\",\"Linux\",\"X64\",\"kungfu-build-v4-linux-x64\"]",
    },
    {
      id: "macos-arm64",
      name: "macOS ARM64",
      runner: "[\"self-hosted\",\"macOS\",\"ARM64\",\"kungfu-build-v4-macos-arm64\"]",
    },
    {
      id: "windows-x64",
      name: "Windows x64",
      runner: "[\"self-hosted\",\"Windows\",\"X64\",\"kungfu-build-v4-windows-x64\"]",
    },
  ],
});

const RUNNER_PRESET_ALIASES = Object.freeze({
  github: "github-hosted",
  "github-hosted-default": "github-hosted",
  kungfu: "kungfu-v4-self-hosted",
  "kungfu-self-hosted": "kungfu-v4-self-hosted",
  "kungfu-v4": "kungfu-v4-self-hosted",
});

export const DEFAULT_ARTIFACT_NAME_TEMPLATE = "{artifact}-{platform}-{sha}";
export const DEFAULT_PUBLISH_REFS = Object.freeze({
  alpha: [
    "^refs/heads/alpha/v\\d+/v\\d+\\.\\d+$",
    "^refs/tags/v\\d+\\.\\d+\\.\\d+-alpha\\.\\d+$",
  ],
  release: [
    "^refs/heads/release/v\\d+/v\\d+\\.\\d+$",
    "^refs/tags/v\\d+\\.\\d+\\.\\d+$",
    "^refs/tags/v\\d+\\.\\d+$",
    "^refs/tags/v\\d+$",
  ],
  major: [
    "^refs/heads/major-gate$",
    "^refs/tags/v\\d+\\.0\\.0$",
    "^refs/tags/v\\d+\\.0$",
    "^refs/tags/v\\d+$",
  ],
});

function parseJsonObject(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function normalizePublishRefs(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return DEFAULT_PUBLISH_REFS;
  }
  const parsed = parseJsonObject(raw, "publish-refs-json");
  const normalized = {};
  for (const [channel, patterns] of Object.entries(parsed)) {
    const key = String(channel || "").trim();
    if (!key) {
      throw new Error("publish-refs-json channel names must be non-empty");
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new Error(`publish-refs-json.${key} must be a non-empty array`);
    }
    normalized[key] = patterns.map((pattern, index) => {
      const value = String(pattern || "").trim();
      if (!value) {
        throw new Error(`publish-refs-json.${key}[${index}] must be non-empty`);
      }
      try {
        new RegExp(value);
      } catch (error) {
        throw new Error(`publish-refs-json.${key}[${index}] is invalid: ${error.message}`);
      }
      return value;
    });
  }
  return normalized;
}

function parseJsonArray(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON array`);
    }
    return parsed;
  } catch (error) {
    if (error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function normalizeRunnerPreset(value) {
  const preset = String(value || "github-hosted").trim() || "github-hosted";
  return RUNNER_PRESET_ALIASES[preset] || preset;
}

function normalizePlatform(platform, index) {
  const id = String(platform?.id || "").trim();
  const name = String(platform?.name || id).trim();
  const runner = String(platform?.runner || "").trim();
  if (!id) {
    throw new Error(`platforms-json[${index}].id is required`);
  }
  if (!name) {
    throw new Error(`platforms-json[${index}].name is required`);
  }
  if (!runner) {
    throw new Error(`platforms-json[${index}].runner is required`);
  }
  parseJsonArray(runner, `platforms-json[${index}].runner`);
  return { id, name, runner };
}

export function resolveRunnerMatrix({ runnerPreset = "github-hosted", platformsJson = "" } = {}) {
  const customPlatformsJson = String(platformsJson || "").trim();
  if (customPlatformsJson) {
    const platforms = parseJsonArray(customPlatformsJson, "platforms-json").map(normalizePlatform);
    if (platforms.length === 0) {
      throw new Error("platforms-json must include at least one platform");
    }
    return {
      source: "platforms-json",
      runnerPreset: "custom",
      platforms,
      platformsJson: JSON.stringify(platforms),
      platformCount: platforms.length,
    };
  }

  const preset = normalizeRunnerPreset(runnerPreset);
  if (preset === "custom") {
    throw new Error("runner-preset=custom requires platforms-json");
  }
  const platforms = RUNNER_PRESETS[preset];
  if (!platforms) {
    throw new Error(`unsupported runner-preset: ${preset}`);
  }
  return {
    source: "runner-preset",
    runnerPreset: preset,
    platforms,
    platformsJson: JSON.stringify(platforms),
    platformCount: platforms.length,
  };
}

export function resolvePublishGate({
  trusted = true,
  publishChannel = "none",
  eventName = "",
  ref = "",
  publishRefsJson = "",
} = {}) {
  const channel = String(publishChannel || "none").trim() || "none";
  const isTrusted = trusted === true || String(trusted) === "true";
  if (channel === "none") {
    return {
      trusted: isTrusted,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: "publish channel is none",
    };
  }
  if (!isTrusted) {
    return {
      trusted: false,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: "event is not trusted",
    };
  }
  if (String(eventName || "") === "pull_request") {
    return {
      trusted: true,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: "pull_request events may verify but may not publish",
    };
  }

  const publishRefs = normalizePublishRefs(publishRefsJson);
  const patterns = publishRefs[channel];
  if (!patterns) {
    return {
      trusted: true,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: `unknown publish channel: ${channel}`,
    };
  }
  const refValue = String(ref || "");
  const matchedPattern = patterns.find((pattern) => new RegExp(pattern).test(refValue));
  if (!matchedPattern) {
    return {
      trusted: true,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: `ref ${refValue || "<empty>"} is not allowed for publish channel ${channel}`,
    };
  }
  return {
    trusted: true,
    publishChannel: channel,
    publishAllowed: true,
    publishReason: `ref matched ${matchedPattern}`,
  };
}

function sanitizeArtifactName(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveArtifactContract({
  artifactName = "buildchain-artifact",
  artifactNameTemplate = DEFAULT_ARTIFACT_NAME_TEMPLATE,
  platformId = "",
  platformName = "",
  sha = "",
  ref = "",
  runId = "",
  runAttempt = "",
} = {}) {
  const baseName = String(artifactName || "buildchain-artifact").trim() || "buildchain-artifact";
  const template =
    String(artifactNameTemplate || "").trim() || DEFAULT_ARTIFACT_NAME_TEMPLATE;
  const replacements = {
    artifact: baseName,
    artifactName: baseName,
    platform: platformId,
    platformId,
    platformName,
    sha,
    shortSha: sha ? sha.slice(0, 12) : "",
    ref,
    runId,
    runAttempt,
  };
  const resolved = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key) => {
    if (!Object.hasOwn(replacements, key)) {
      throw new Error(`unsupported artifact-name-template placeholder: ${match}`);
    }
    return replacements[key] || "";
  });
  const safeName = sanitizeArtifactName(resolved);
  if (!safeName) {
    throw new Error("artifact-name-template resolved to an empty artifact name");
  }
  return {
    artifactName: safeName,
    artifactBaseName: baseName,
    artifactNameTemplate: template,
    platform: {
      id: platformId,
      name: platformName || platformId,
    },
  };
}

export function parseExpectedArtifactsJson(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const expected = parseJsonObject(raw, "expected-artifacts-json");
  const normalized = {};
  if (expected.minFiles !== undefined) {
    normalized.minFiles = Number(expected.minFiles);
    if (!Number.isInteger(normalized.minFiles) || normalized.minFiles < 0) {
      throw new Error("expected-artifacts-json.minFiles must be a non-negative integer");
    }
  }
  if (expected.maxFiles !== undefined) {
    normalized.maxFiles = Number(expected.maxFiles);
    if (!Number.isInteger(normalized.maxFiles) || normalized.maxFiles < 0) {
      throw new Error("expected-artifacts-json.maxFiles must be a non-negative integer");
    }
  }
  if (expected.minTotalBytes !== undefined) {
    normalized.minTotalBytes = Number(expected.minTotalBytes);
    if (!Number.isInteger(normalized.minTotalBytes) || normalized.minTotalBytes < 0) {
      throw new Error("expected-artifacts-json.minTotalBytes must be a non-negative integer");
    }
  }
  if (expected.requiredPaths !== undefined) {
    if (!Array.isArray(expected.requiredPaths)) {
      throw new Error("expected-artifacts-json.requiredPaths must be an array");
    }
    normalized.requiredPaths = expected.requiredPaths.map((entry, index) => {
      const pathValue = String(entry || "").replace(/\\/g, "/").trim();
      if (!pathValue) {
        throw new Error(`expected-artifacts-json.requiredPaths[${index}] must be non-empty`);
      }
      return pathValue;
    });
  }
  return normalized;
}

export function createArtifactSummary({ artifactName, platform, files }) {
  const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    digest.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  return {
    contract: "kungfu-buildchain-artifact-summary",
    artifactName,
    platform,
    fileCount: files.length,
    totalBytes,
    digest: digest.digest("hex"),
  };
}

export function validateExpectedArtifacts({ expected, files, summary }) {
  if (!expected) {
    return { ok: true, source: "none", checks: [] };
  }
  const checks = [];
  const paths = new Set(files.map((file) => file.path));
  function addCheck(name, ok, detail) {
    checks.push({ name, ok, detail });
    if (!ok) {
      throw new Error(`expected artifact check failed: ${name}: ${detail}`);
    }
  }

  if (expected.minFiles !== undefined) {
    addCheck(
      "minFiles",
      summary.fileCount >= expected.minFiles,
      `${summary.fileCount} >= ${expected.minFiles}`,
    );
  }
  if (expected.maxFiles !== undefined) {
    addCheck(
      "maxFiles",
      summary.fileCount <= expected.maxFiles,
      `${summary.fileCount} <= ${expected.maxFiles}`,
    );
  }
  if (expected.minTotalBytes !== undefined) {
    addCheck(
      "minTotalBytes",
      summary.totalBytes >= expected.minTotalBytes,
      `${summary.totalBytes} >= ${expected.minTotalBytes}`,
    );
  }
  for (const requiredPath of expected.requiredPaths || []) {
    addCheck("requiredPath", paths.has(requiredPath), requiredPath);
  }
  return { ok: true, source: "expected-artifacts-json", checks };
}

export function writeGitHubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    for (const [key, value] of Object.entries(outputs)) {
      console.log(`${key}=${value}`);
    }
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`);
}

export function findJsonFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return root.endsWith(".json") ? [root] : [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => findJsonFiles(path.join(root, entry.name)));
}
