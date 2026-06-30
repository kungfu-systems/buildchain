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
    summary,
  };
}

export default {
  validateConfigAction,
};

