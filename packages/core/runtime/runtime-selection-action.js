import { context, getOctokit } from "@actions/github";
import { selectRuntime } from "./runtime-selection.js";

export async function runtimeSelectionAction(core) {
  const request = {
    purpose: core.getInput("purpose", { required: true }),
    repository: core.getInput("repository", { required: true }),
    requestedRef: core.getInput("ref"),
    workflowSha: core.getInput("workflow-sha", { required: true }),
    workflowRef: core.getInput("workflow-ref"),
  };
  const result = await selectRuntime(request, {
    context,
    github: getOctokit(core.getInput("token", { required: true })),
  });
  for (const [name, value] of Object.entries(result))
    core.setOutput(name, value);
  if (request.purpose === "web")
    await core.summary
      .addHeading("Buildchain runtime")
      .addCodeBlock(
        JSON.stringify(
          {
            workflow: request.workflowRef,
            definition: request.workflowSha,
            ...result,
          },
          null,
          2,
        ),
        "json",
      )
      .write();
}
