import fs from "node:fs";
import path from "node:path";
import { getOctokit } from "@actions/github";
import { installationRoot } from "../../runtime/installation-root.js";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";
import { routePromotion } from "./routing.js";
import { bindPromotionSelection } from "./selection.js";
import { admitPromotionInvocation } from "./admission.js";
import { verifyPromotionInvocation } from "../promotion-request.js";
import { classifyProductPublication } from "./product-state.js";
import { productPublicationReader } from "../../providers/github/product-publication.js";
const get = (core, key) => core.getInput(key, { required: true });
const emit = (core, value) => {
  for (const [key, item] of Object.entries(value)) core.setOutput(key, item);
};
function context(env) {
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  return {
    repo: { owner, repo },
    sha: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    eventName: env.GITHUB_EVENT_NAME,
    actor: env.GITHUB_ACTOR,
    payload: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
  };
}
function requireRuntime(workspace, relative, sha) {
  const runtimeRoot = installationRoot(import.meta.url);
  if (
    fs.realpathSync(runtimeRoot) !==
    fs.realpathSync(path.join(workspace, relative))
  )
    throw new Error(
      "Promotion action is outside its admitted runtime checkout",
    );
  verifyCheckoutIdentity({
    directory: runtimeRoot,
    sha,
    label: "Promotion action runtime",
  });
  return runtimeRoot;
}
export async function routePromotionAction(core, env) {
  const workflowSha = get(core, "workflow-sha"),
    workspace = path.resolve(env.GITHUB_WORKSPACE);
  const runtimeRoot = requireRuntime(
    workspace,
    ".buildchain/workflow-shell",
    workflowSha,
  );
  emit(
    core,
    await routePromotion({
      request: get(core, "request-json"),
      workflowRepository: get(core, "workflow-repository"),
      workflowSha,
      workflowRef: get(core, "workflow-ref"),
      packageVersion: JSON.parse(
        fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"),
      ).version,
      github: getOctokit(get(core, "token")),
      context: context(env),
    }),
  );
}
export function bindPromotionSelectionAction(core, env) {
  const selection = JSON.parse(get(core, "selection-json")),
    request = JSON.parse(get(core, "request-json")),
    workspace = path.resolve(env.GITHUB_WORKSPACE);
  requireRuntime(
    workspace,
    ".buildchain/workflow-shell",
    selection["shell-sha"],
  );
  emit(
    core,
    bindPromotionSelection({
      request,
      selection,
      workspace,
      sourceSha: request["target-sha"] || env.GITHUB_SHA,
    }),
  );
}
export async function admitPromotionInvocationAction(core, env) {
  const selection = JSON.parse(get(core, "selection-json")),
    workspace = path.resolve(env.GITHUB_WORKSPACE);
  requireRuntime(
    workspace,
    ".buildchain/policy-runtime",
    selection["router-sha"],
  );
  emit(
    core,
    await admitPromotionInvocation({
      request: JSON.parse(get(core, "request-json")),
      selection,
      workspace,
      consumerPolicyRoot: get(core, "consumer-policy-root"),
      github: getOctokit(get(core, "token")),
      context: context(env),
    }),
  );
}
export function inspectPromotionInvocationAction(core, env) {
  const workflowSha = get(core, "workflow-sha");
  requireRuntime(
    path.resolve(env.GITHUB_WORKSPACE),
    ".buildchain/workflow-shell",
    workflowSha,
  );
  verifyPromotionInvocation(get(core, "request-json"), workflowSha);
}
export async function classifyPublicationHeadAction(core, env) {
  requireRuntime(path.resolve(env.GITHUB_WORKSPACE), ".", env.GITHUB_SHA);
  const event = context(env).payload.workflow_run;
  if (!event || !/^[0-9a-f]{40}$/u.test(event.head_sha || ""))
    throw new Error(
      "Publication classification requires a workflow run with an exact source SHA",
    );
  const result = await classifyProductPublication(
    { requestedSha: event.head_sha, targetRef: event.head_branch },
    productPublicationReader(
      getOctokit(get(core, "token")),
      env.GITHUB_REPOSITORY,
    ),
  );
  emit(core, result);
  if (result["finalized-version"])
    core.info(
      `Publication head finalizes v${result["finalized-version"]}; no new promotion is required.`,
    );
}
