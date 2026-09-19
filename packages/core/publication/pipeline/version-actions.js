import path from "node:path";
import { pipelineHost } from "../../workflow/pipeline/host.js";
import { githubJsonClient } from "../../providers/github/json-client.js";
import { githubPipelineVersionArtifacts } from "../../providers/github/pipeline-version-artifacts.js";
import { buildPipelineVersionMaterial } from "./version-build.js";
import { qualifyPipelineVersionContext } from "./version-context.js";
import { preparePipelinePublication } from "./prepare.js";
import { settlePipelinePublication } from "./settle.js";
import {
  readPipelineContext,
  writePipelineContext,
} from "../../providers/github/pipeline-context-artifacts.js";

const contextInput = (core, env) =>
  readPipelineContext(core.getInput("context", { required: true }), env);
const directory = (env) =>
  path.join(env.GITHUB_WORKSPACE, ".buildchain/version-material");

export async function buildPipelineVersionAction(core, env) {
  const context = await contextInput(core, env);
  if (
    context.schema !== "buildchain.pipeline-version-context/v1" ||
    context.runId !== Number(env.GITHUB_RUN_ID) ||
    context.runAttempt !== Number(env.GITHUB_RUN_ATTEMPT)
  )
    throw new Error(
      "Version build requires its exact provider execution context",
    );
  const result = await buildPipelineVersionMaterial({
    cwd: path.join(env.GITHUB_WORKSPACE, ".buildchain/product"),
    preparation: context.preparation,
    platform: core.getInput("platform", { required: true }),
    environment: env,
  });
  await githubPipelineVersionArtifacts({}).upload(
    context,
    result,
    directory(env),
  );
}

export async function materializePipelinePublicationAction(core, env) {
  const context = await contextInput(core, env);
  const operation = core.getInput("operation", { required: true });
  let result = { operation, context };
  if (operation === "regenerate") {
    if (context.preparation.purpose !== "publication")
      throw new Error(
        "Publication materialization received a different version purpose",
      );
    const host = await pipelineHost(core, env, "Materialize publication");
    await qualifyPipelineVersionContext(context, host, directory(env));
    result = await preparePipelinePublication(
      context.attempt,
      context.definitionSha,
      host,
    );
    if (result.operation === "regenerate")
      throw new Error(
        "Qualified version preparation did not materialize its source",
      );
  }
  core.setOutput("operation", result.operation);
  core.setOutput("stable-wait", result.wait ? JSON.stringify(result.wait) : "");
  core.setOutput(
    "context",
    operation === "regenerate"
      ? await writePipelineContext(result.context || {}, env)
      : core.getInput("context", { required: true }),
  );
  core.setOutput(
    "matrix",
    JSON.stringify({ include: result.context?.platforms || [] }),
  );
}

export async function materializePipelineDevelopmentAction(core, env) {
  const context = await contextInput(core, env);
  if (context.preparation.purpose !== "development")
    throw new Error(
      "Development materialization received a different version purpose",
    );
  const host = await pipelineHost(core, env, "Materialize next development");
  const prToken = core.getInput("pr-token", { required: true });
  if (prToken !== host.token)
    host.pullRequests = githubJsonClient({
      token: prToken,
      userAgent: "buildchain-next-development",
    });
  await qualifyPipelineVersionContext(context, host, directory(env));
  const result = await settlePipelinePublication(
    context.publication,
    host,
    directory(env),
    env,
  );
  if (result.versionContext)
    throw new Error(
      "Qualified development preparation did not materialize its source",
    );
  core.info(result.reason);
}
