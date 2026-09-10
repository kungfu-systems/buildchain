import { pathToFileURL } from "node:url";
import { resolveBuildConfiguration } from "../plan/configuration.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const resolved = resolveBuildConfiguration({
      root: process.env.BUILDCHAIN_CONSUMER_ROOT,
      locator: process.env.BUILDCHAIN_CONFIG_PATH,
      workflowRef: process.env.BUILDCHAIN_WORKFLOW_REF,
      workflowSha: process.env.BUILDCHAIN_WORKFLOW_SHA,
      repository: process.env.BUILDCHAIN_WORKFLOW_REPOSITORY,
      sourceSha: process.env.GITHUB_SHA,
      sourceRef: process.env.GITHUB_REF,
      callerWorkflowRef: process.env.GITHUB_WORKFLOW_REF,
      eventName: process.env.GITHUB_EVENT_NAME,
      baseRef: process.env.GITHUB_BASE_REF,
    });
    writeGitHubOutputs({ "plan-json": JSON.stringify(resolved.plan), "plan-root": resolved.root });
  } catch (error) {
    console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`);
    process.exitCode = 1;
  }
}
