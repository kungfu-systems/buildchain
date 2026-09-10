import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { verifyRepository } from "../../build/verification/repository.js";
import { npmPublishDryRun } from "./preview.js";
export function previewNpmPublication(
  { workspace, runCheck, env },
  { verify = verifyRepository, preview = npmPublishDryRun } = {},
) {
  if (runCheck) verify({ workspace, env });
  return preview({ cwd: workspace, env });
}
export function previewNpmPublicationAction(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  if (
    fs.realpathSync(installationRoot(import.meta.url)) !==
    fs.realpathSync(workspace)
  )
    throw new Error(
      "npm preview requires the checked-out source implementation",
    );
  const result = previewNpmPublication({
    workspace,
    runCheck: core.getBooleanInput("run-check"),
    env,
  });
  core.info(
    `npm preview qualified: ${result.package.name}@${result.package.version}; ${result.pack.entryCount} package entries`,
  );
}
