import path from "node:path";
import { verifyRepository } from "../../build/verification/repository.js";
import { npmPublishDryRun } from "./preview.js";
export function previewNpmPublication(
  { workspace, runCheck, env },
  { verify = verifyRepository, preview = npmPublishDryRun } = {},
) {
  if (runCheck) verify({ workspace, env });
  return preview({ cwd: workspace, env });
}
export function previewNpmPublicationAction(core, env, dependencies) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const result = previewNpmPublication(
    {
      workspace,
      runCheck: core.getBooleanInput("run-check"),
      env,
    },
    dependencies,
  );
  core.info(
    `npm preview qualified: ${result.package.name}@${result.package.version}; ${result.pack.entryCount} package entries`,
  );
}
