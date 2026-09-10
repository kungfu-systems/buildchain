import { RUNNER_PRESETS } from "./presets.js";
import { LINUX_CONTAINER_PRESETS } from "./presets.js";
import { parseJsonArray } from "../../contracts/structured-values.js";
import { macosJitRunnerLabel } from "../../providers/commands/aws-macos-jit-core.mjs";
import { windowsJitRunnerLabel } from "../../providers/commands/aws-windows-jit-core.mjs";
export function normalizeRunnerPreset(value) {
  const preset = String(value || "github-hosted").trim() || "github-hosted";
  return preset;
}

export function normalizeLinuxContainerPreset(value) {
  const preset = String(value || "").trim();
  return preset;
}

export function resolveLinuxContainer({
  linuxContainerPreset = "",
  linuxContainerImage = "",
} = {}) {
  const explicitImage = String(linuxContainerImage || "").trim();
  const preset = normalizeLinuxContainerPreset(linuxContainerPreset);
  if (explicitImage) {
    if (preset && preset !== "custom") {
      throw new Error(
        "linux-container-image cannot be combined with a named linux-container-preset",
      );
    }
    return {
      enabled: true,
      preset: preset || "custom",
      image: explicitImage,
      source: "linux-container-image",
    };
  }
  if (!preset) {
    return {
      enabled: false,
      preset: "",
      image: "",
      source: "none",
    };
  }
  const resolved = LINUX_CONTAINER_PRESETS[preset];
  if (!resolved) {
    throw new Error(`unsupported linux-container-preset: ${preset}`);
  }
  return {
    enabled: true,
    preset,
    image: resolved.image,
    source: "linux-container-preset",
  };
}

export function platformIsLinux(platform) {
  const id = String(platform?.id || "").toLowerCase();
  const name = String(platform?.name || "").toLowerCase();
  if (id.includes("linux") || name.includes("linux")) {
    return true;
  }
  const runnerLabels = parseJsonArray(
    String(platform?.runner || "[]"),
    "platform.runner",
  ).map((label) => String(label || "").toLowerCase());
  return runnerLabels.some(
    (label) => label.includes("linux") || label.includes("ubuntu"),
  );
}

export function platformUsesGitHubHostedRunner(platform, index) {
  if (platform?.githubHosted !== undefined) {
    if (typeof platform.githubHosted !== "boolean") {
      throw new Error(
        `platforms-json[${index}].githubHosted must be a boolean`,
      );
    }
    return platform.githubHosted;
  }
  if (String(platform?.provider || "").trim()) {
    return false;
  }
  const runnerLabels = parseJsonArray(
    String(platform?.runner || "[]"),
    `platforms-json[${index}].runner`,
  ).map((label) => String(label || "").toLowerCase());
  if (runnerLabels.includes("self-hosted") || runnerLabels.length !== 1) {
    return false;
  }
  return /^(ubuntu-(latest|20\.04|22\.04|24\.04|24\.04-arm)|windows-(latest|2019|2022|2025|11-arm)|macos-(latest|13|14|15|26)(-intel)?)$/.test(
    runnerLabels[0],
  );
}

export function bindRunnerHosting(platforms) {
  return platforms.map((platform, index) => ({
    ...platform,
    githubHosted: platformUsesGitHubHostedRunner(platform, index),
  }));
}

export function runnerHostingSummary(platforms) {
  const githubHostedPlatforms = platforms.filter(
    (platform) => platform.githubHosted,
  );
  const relayPlatforms = platforms.filter((platform) => !platform.githubHosted);
  return {
    githubHostedPlatforms,
    githubHostedPlatformsJson: JSON.stringify(githubHostedPlatforms),
    githubHostedPlatformIdsJson: JSON.stringify(
      githubHostedPlatforms.map((platform) => platform.id),
    ),
    githubHostedPlatformCount: githubHostedPlatforms.length,
    relayPlatforms,
    relayPlatformsJson: JSON.stringify(relayPlatforms),
    relayPlatformCount: relayPlatforms.length,
  };
}

export function normalizePlatform(platform, index) {
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
  const capabilities =
    platform?.capabilities === undefined
      ? ["node"]
      : parseJsonArray(
          JSON.stringify(platform.capabilities),
          `platforms-json[${index}].capabilities`,
        ).map((capability) => String(capability || "").trim());
  if (
    capabilities.some((capability) => !capability) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    throw new Error(
      `platforms-json[${index}].capabilities must contain unique non-empty strings`,
    );
  }
  const normalized = { id, name, runner };
  if (platform?.platform !== undefined)
    normalized.platform = String(platform.platform || "").trim();
  if (platform?.provider !== undefined)
    normalized.provider = String(platform.provider || "").trim();
  if (platform?.project !== undefined)
    normalized.project = String(platform.project || "").trim();
  if (platform?.githubHosted !== undefined)
    normalized.githubHosted = platform.githubHosted;
  normalized.capabilities = capabilities.sort();
  if (platform?.environment !== undefined)
    normalized.environment = platform.environment;
  if (platform?.required === false) normalized.required = false;
  return normalized;
}

export function resolveRunnerMatrix({
  runnerPreset = "github-hosted",
  platformsJson = "",
  awsCodeBuildProject = "",
  awsEc2WindowsRunnerLabel = "",
  awsEc2MacosRunnerLabel = "",
  linuxContainerPreset = "",
  linuxContainerImage = "",
} = {}) {
  const customPlatformsJson = String(platformsJson || "").trim();
  const linuxContainer = resolveLinuxContainer({
    linuxContainerPreset,
    linuxContainerImage,
  });
  if (customPlatformsJson) {
    const platforms = bindRunnerHosting(
      parseJsonArray(customPlatformsJson, "platforms-json").map(
        normalizePlatform,
      ),
    );
    if (platforms.length === 0) {
      throw new Error("platforms-json must include at least one platform");
    }
    const containerPlatforms = linuxContainer.enabled
      ? platforms.filter(platformIsLinux)
      : [];
    const nativePlatforms = linuxContainer.enabled
      ? platforms.filter((platform) => !platformIsLinux(platform))
      : platforms;
    return {
      source: "platforms-json",
      runnerPreset: "custom",
      platforms,
      platformsJson: JSON.stringify(platforms),
      platformCount: platforms.length,
      nativePlatforms,
      nativePlatformsJson: JSON.stringify(nativePlatforms),
      nativePlatformCount: nativePlatforms.length,
      containerPlatforms,
      containerPlatformsJson: JSON.stringify(containerPlatforms),
      containerPlatformCount: containerPlatforms.length,
      linuxContainer,
      ...runnerHostingSummary(platforms),
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
  let resolvedPlatforms = platforms;
  if (preset === "aws-us-codebuild-linux") {
    const project = String(awsCodeBuildProject || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,149}$/.test(project)) {
      throw new Error(
        "runner-preset=aws-us-codebuild-linux requires a valid aws-codebuild-project",
      );
    }
    resolvedPlatforms = platforms.map((platform) => ({ ...platform, project }));
  }
  if (preset === "aws-us-ec2-windows-jit") {
    const runnerLabel = windowsJitRunnerLabel(awsEc2WindowsRunnerLabel);
    resolvedPlatforms = platforms.map((platform) => ({
      ...platform,
      runnerLabel,
      runner: JSON.stringify(["self-hosted", "Windows", "X64", runnerLabel]),
    }));
  }
  if (preset === "aws-us-ec2-macos-jit") {
    const runnerLabel = macosJitRunnerLabel(awsEc2MacosRunnerLabel);
    resolvedPlatforms = platforms.map((platform) => ({
      ...platform,
      runnerLabel,
      runner: JSON.stringify(["self-hosted", "macOS", "ARM64", runnerLabel]),
    }));
  }
  resolvedPlatforms = bindRunnerHosting(resolvedPlatforms);
  const containerPlatforms = linuxContainer.enabled
    ? resolvedPlatforms.filter(platformIsLinux)
    : [];
  const nativePlatforms = linuxContainer.enabled
    ? resolvedPlatforms.filter((platform) => !platformIsLinux(platform))
    : resolvedPlatforms;
  return {
    source: "runner-preset",
    runnerPreset: preset,
    platforms: resolvedPlatforms,
    platformsJson: JSON.stringify(resolvedPlatforms),
    platformCount: resolvedPlatforms.length,
    nativePlatforms,
    nativePlatformsJson: JSON.stringify(nativePlatforms),
    nativePlatformCount: nativePlatforms.length,
    containerPlatforms,
    containerPlatformsJson: JSON.stringify(containerPlatforms),
    containerPlatformCount: containerPlatforms.length,
    linuxContainer,
    ...runnerHostingSummary(resolvedPlatforms),
  };
}
