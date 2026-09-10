import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";
import { qualifyPublicationCandidate } from "./qualification.js";
export async function qualifyPublicationCandidateAction(core, env) {
  const input = JSON.parse(core.getInput("request-json", { required: true }));
  const workspace = path.resolve(env.GITHUB_WORKSPACE),
    cwd = path.resolve(workspace, input["working-directory"] || ".");
  if (path.relative(workspace, cwd).split(path.sep).includes(".."))
    throw new Error(
      "Publication working directory escapes its admitted source",
    );
  verifyCheckoutIdentity({
    directory: installationRoot(import.meta.url),
    sha: core.getInput("runtime-sha", { required: true }),
    label: "Publication runtime",
  });
  const request = {
    cwd,
    env,
    sourceSha: env.GITHUB_SHA,
    repository: env.GITHUB_REPOSITORY,
    preparePaperPackage: input["prepare-paper-package"] === true,
    packageName: input["package-name"],
    publishDistTag: input["publish-dist-tag"],
    targetRef: input["target-ref"] || env.GITHUB_REF_NAME,
    toolchainType: input["toolchain-type"],
    toolchainImage: input["toolchain-image"],
    toolchainDigest: input["toolchain-digest"],
    toolchainCommand: input["toolchain-command"],
    buildCommand: input["build-command"],
    verifyCommand: input["verify-command"],
  };
  return qualifyPublicationCandidate(request, {
    observe: ({ outcomes, manifest, package: pkg }) => {
      core.setOutput("outcomes-json", JSON.stringify(outcomes));
      for (const [key, value] of Object.entries({ ...manifest, ...pkg }))
        core.setOutput(key, value);
    },
  });
}
