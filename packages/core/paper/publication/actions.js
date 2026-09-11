import * as github from "@actions/github";
import { installationRoot } from "../../runtime/installation-root.js";
import { verifyAdmittedCandidate } from "./candidate.js";
import { planPaperPublication, receiptPaperPublication } from "./controller.js";
import { resolvePaperTarget, lockPaperPublicationTarget } from "./target.js";
import { sealReleaseEnvelope } from "./envelope.js";
import { capturePaperPropagation } from "./propagation.js";
const json = (core, name) =>
  JSON.parse(core.getInput(name, { required: true }));
const outputs = (core, values) => {
  for (const [key, value] of Object.entries(values)) core.setOutput(key, value);
};
export function admitPaperCandidateAction(core, env) {
  const request = json(core, "request-json"),
    candidate = json(core, "candidate-plan-json"),
    runtimeRoot = installationRoot(import.meta.url);
  const admitted = verifyAdmittedCandidate({
    workspace: env.GITHUB_WORKSPACE,
    runtimeRoot,
    repository: env.GITHUB_REPOSITORY,
    runtimeSha: candidate["runtime-sha"],
    capability: json(core, "capability-json"),
    packageName: candidate["package-name"],
    packageVersion: candidate["package-version"],
    distTag: candidate["publish-dist-tag"],
    githubRelease: request["github-release"],
  });
  const plan = planPaperPublication({
    workspace: env.GITHUB_WORKSPACE,
    runtimeRoot,
    repository: env.GITHUB_REPOSITORY,
    request,
  });
  outputs(core, {
    "candidate-json": JSON.stringify(admitted),
    "package-name": admitted["package-name"],
    "package-version": admitted["package-version"],
    ...plan,
  });
}
export async function lockPaperPublicationAction(core, env) {
  const request = json(core, "request-json"),
    candidate = json(core, "candidate-json");
  const target = resolvePaperTarget({
    workspace: env.GITHUB_WORKSPACE,
    ref: request["target-ref"] || env.GITHUB_REF_NAME,
    sha: request["target-sha"] || env.GITHUB_SHA,
  });
  const locked = await lockPaperPublicationTarget({
    github: github.getOctokit(core.getInput("token", { required: true })),
    repository: env.GITHUB_REPOSITORY,
    target,
    version: candidate["package-version"],
  });
  outputs(core, {
    "target-json": JSON.stringify(locked),
    "provider-json": JSON.stringify({
      kind: "npm",
      directory: candidate["package-dir"],
    }),
  });
}
export async function observePaperPublicationAction(core, env) {
  const candidate = json(core, "candidate-json"),
    result = json(core, "publication-json"),
    target = json(core, "target-json");
  const publication = {
    workspace: env.GITHUB_WORKSPACE,
    repository: env.GITHUB_REPOSITORY,
    sourceSha: target.sha,
    channel: target.channel,
    packageName: candidate["package-name"],
    packageVersion: candidate["package-version"],
    releaseTag: result["public-release-tag"],
    passportPath: result["release-passport-path"],
  };
  const envelope = await sealReleaseEnvelope(publication);
  outputs(core, {
    "upstream-release-json": JSON.stringify(envelope),
    "readback-outcome": "success",
  });
  const propagation = await capturePaperPropagation({
    ...publication,
    github: github.getOctokit(core.getInput("token", { required: true })),
  });
  outputs(core, {
    "propagation-configured": String(propagation.configured),
    "propagation-work-artifact": propagation["artifact-name"] || "",
  });
}
export function finalizePaperPublicationAction(core, env) {
  const candidate = json(core, "candidate-json"),
    publication = json(core, "publication-json"),
    observations = json(core, "observations-json");
  const receipt = receiptPaperPublication({
    workspace: env.GITHUB_WORKSPACE,
    publishOutcome: core.getInput("publish-outcome", { required: true }),
    readbackOutcome:
      observations.observe?.outputs?.["readback-outcome"] ||
      observations.observe?.outcome,
    aggregateOutcome: core.getInput("aggregate-outcome", { required: true }),
    manifestPath: candidate["manifest-path"],
    passportPath: publication["release-passport-path"],
    releaseTag: publication["public-release-tag"],
  });
  outputs(core, receipt);
  if (receipt["controller-receipt-qualifying"] !== "true")
    throw new Error("Paper publication controller did not qualify");
}
