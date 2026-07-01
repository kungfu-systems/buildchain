import { validateBuildchainConfig } from "../../packages/core/buildchain-config.js";

function parseStageList(value) {
  return String(value || "")
    .split(",")
    .map((stage) => stage.trim())
    .filter(Boolean);
}

export function validateConfigAction({
  cwd = process.cwd(),
  configRequired = true,
  requireVersionState = false,
  requireLifecycleStages = "",
} = {}) {
  const summary = validateBuildchainConfig(cwd, {
    requireConfig: configRequired,
    requireVersionState,
    requireLifecycleStages: parseStageList(requireLifecycleStages),
  });

  return {
    configPath: summary.config?.path || "",
    versionFiles: summary.versionFiles.map((file) => file.path),
    lifecycleStages: summary.lifecycleStages.map((stage) => stage.name),
    projectType: summary.project?.type || "",
    projectName: summary.project?.name || "",
    projectSite: summary.project?.site || "",
    channels: summary.channels ? Object.keys(summary.channels) : [],
    deployAdapters: summary.deploy
      ? Object.fromEntries(Object.entries(summary.deploy).map(([name, deploy]) => [name, deploy.adapter]))
      : {},
    versionStrategy: summary.version?.strategy || "",
    versionNext: summary.version?.next || "",
    anchorManifest: summary.anchorManifest?.path || "",
    summary,
  };
}

export default {
  validateConfigAction,
};
