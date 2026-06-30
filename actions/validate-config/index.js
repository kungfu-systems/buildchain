import * as core from "@actions/core";
import { validateConfigAction } from "./lib.js";

async function main() {
  const result = validateConfigAction({
    cwd: process.cwd(),
    configRequired: core.getBooleanInput("config-required"),
    requireVersionState: core.getBooleanInput("require-version-state"),
    requireLifecycleStages: core.getInput("require-lifecycle-stages"),
  });

  core.setOutput("config-path", result.configPath);
  core.setOutput("version-files", result.versionFiles.join(","));
  core.setOutput("lifecycle-stages", result.lifecycleStages.join(","));
  core.setOutput("version-strategy", result.versionStrategy);
  core.setOutput("version-next", result.versionNext);
  core.setOutput("anchor-manifest", result.anchorManifest);

  await core.summary
    .addHeading("Buildchain config validation")
    .addTable([
      [
        { data: "Field", header: true },
        { data: "Value", header: true },
      ],
      ["Config", result.configPath || "(none)"],
      ["Version strategy", result.versionStrategy ? `${result.versionStrategy}/${result.versionNext}` : "(none)"],
      ["Anchor manifest", result.anchorManifest || "(none)"],
      ["Version files", result.versionFiles.join(", ") || "(none)"],
      ["Lifecycle stages", result.lifecycleStages.join(", ") || "(none)"],
    ])
    .write();
}

main().catch((error) => {
  console.error(error);
  core.setFailed(error.message);
});
