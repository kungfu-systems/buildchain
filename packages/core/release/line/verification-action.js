import path from "node:path";
import { verifyReleaseLineage } from "./verification.js";
export function verifyReleaseLineageAction(core, env) {
  const result = verifyReleaseLineage({
    workspace: path.resolve(
      env.GITHUB_WORKSPACE,
      core.getInput("directory", { required: true }),
    ),
    headRef: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
    baseRef: env.GITHUB_BASE_REF || env.GITHUB_REF_NAME,
  });
  for (const [key, value] of Object.entries(result)) core.setOutput(key, value);
}
