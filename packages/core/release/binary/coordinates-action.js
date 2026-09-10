import { getOctokit } from "@actions/github";
import { command } from "../../runtime/action-process.mjs";
import { installationRoot } from "../../runtime/installation-root.js";
import { resolveBinaryPublicationCoordinates } from "./coordinates.js";
export async function resolveBinaryPublicationAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const executingSha = command(
    "git",
    ["-C", installationRoot(import.meta.url), "rev-parse", "HEAD"],
    { stdio: "pipe" },
  ).trim();
  if (executingSha !== env.GITHUB_SHA)
    throw new Error(
      "Binary publication coordinator must execute exact workflow source bytes",
    );
  const values = await resolveBinaryPublicationCoordinates({
    repository: env.GITHUB_REPOSITORY,
    runId: request["evidence-run-id"],
    tag: request["release-tag"],
    runtime: request["buildchain-ref"],
    workflowSha: env.GITHUB_SHA,
    github: getOctokit(core.getInput("token", { required: true })),
  });
  for (const [key, value] of Object.entries(values)) core.setOutput(key, value);
}
