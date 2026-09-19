import path from "node:path";
import { pipelineHost } from "../../workflow/pipeline/host.js";
import { buildPipelineSource } from "../../workflow/pipeline/build.js";
import { githubPipelinePublicationArtifacts } from "../../providers/github/pipeline-publication-artifacts.js";
import { preparePipelinePublication } from "./prepare.js";
import { packPipelineProducts } from "./pack.js";
import {
  preparePipelineQualification,
  sealPipelineQualification,
} from "./qualify.js";
import { applyPipelinePublication } from "./apply.js";
import { settlePipelinePublication } from "./settle.js";
import { githubJsonClient } from "../../providers/github/json-client.js";
import {
  readPipelineContext,
  writePipelineContext,
} from "../../providers/github/pipeline-context-artifacts.js";

const contextInput = (core, env) =>
  readPipelineContext(core.getInput("context", { required: true }), env);
const directory = (env) =>
  path.join(env.GITHUB_WORKSPACE, ".buildchain/publication");

export async function preparePipelinePublicationAction(core, env) {
  const host = await pipelineHost(core, env, "Prepare publication");
  const result = await preparePipelinePublication(
    core.getInput("attempt", { required: true }),
    core.getInput("definition-sha", { required: true }),
    host,
  );
  core.setOutput("operation", result.operation);
  core.setOutput("stable-wait", result.wait ? JSON.stringify(result.wait) : "");
  core.setOutput(
    "context",
    await writePipelineContext(result.context || {}, env),
  );
  core.setOutput(
    "matrix",
    JSON.stringify({ include: result.context?.platforms || [] }),
  );
}

export async function buildPipelinePublicationAction(core, env) {
  const context = await contextInput(core, env);
  const platform = core.getInput("platform", { required: true });
  const cwd = path.join(env.GITHUB_WORKSPACE, ".buildchain/product");
  await buildPipelineSource({
    cwd,
    source: context.materialization.source,
    platform,
    environment: env,
  });
  const output = path.join(directory(env), "products");
  const manifest = packPipelineProducts({
    cwd,
    output,
    plan: context.plan,
    platform,
    source: context.materialization.source,
    environment: env,
  });
  const artifacts = githubPipelinePublicationArtifacts({});
  await artifacts.upload(context.plan, manifest, output);
}

export async function preparePipelineQualificationAction(core, env) {
  const host = await pipelineHost(core, env, "Qualify and sign products");
  const prepared = await preparePipelineQualification(
    await contextInput(core, env),
    host,
    directory(env),
  );
  core.setOutput("subject-path", prepared.subjectPath);
  core.setOutput("predicate-path", prepared.predicatePath);
  core.setOutput("predicate-type", prepared.predicateType);
}

export async function sealPipelineQualificationAction(core, env) {
  const host = await pipelineHost(core, env, "Qualify and sign products");
  await sealPipelineQualification(
    await contextInput(core, env),
    host,
    directory(env),
    core.getInput("bundle-path", { required: true }),
  );
}

export async function applyPipelinePublicationAction(core, env) {
  const host = await pipelineHost(core, env, "Apply qualified publication");
  const result = await applyPipelinePublication(
    await contextInput(core, env),
    host,
    directory(env),
    env,
  );
  core.setOutput("stable-wait", result.wait ? JSON.stringify(result.wait) : "");
}

export async function settlePipelinePublicationAction(core, env) {
  const host = await pipelineHost(core, env, "Settle product follow-ups");
  const prToken = core.getInput("pr-token");
  if (prToken && prToken !== host.token)
    host.pullRequests = githubJsonClient({
      token: prToken,
      userAgent: "buildchain-next-development",
    });
  const result = await settlePipelinePublication(
    await contextInput(core, env),
    host,
    directory(env),
    env,
  );
  core.info(result.reason);
  core.setOutput(
    "version-context",
    await writePipelineContext(result.versionContext || {}, env),
  );
  core.setOutput("operation", result.versionContext ? "regenerate" : "wait");
  core.setOutput(
    "matrix",
    JSON.stringify({ include: result.versionContext?.platforms || [] }),
  );
}
