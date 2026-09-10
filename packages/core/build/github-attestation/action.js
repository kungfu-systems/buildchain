import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";
import { validateAttestationInput } from "./admission.js";
import { prepareAttestation, sealAttestation } from "./transaction.js";
export function admitAttestationAction(core, env) {
 const input = JSON.parse(core.getInput("request-json", { required: true }));
 validateAttestationInput({ runtimeSha: input["buildchain-ref"], definitionSha: core.getInput("definition-sha", { required: true }), evidenceRunId: input["evidence-run-id"], currentRunId: env.GITHUB_RUN_ID,
  sourceSha: input["source-sha"], currentSourceSha: env.GITHUB_SHA, subjectRelativePath: input["subject-relative-path"], platformManifestRelativePath: input["platform-manifest-relative-path"], releasePassportRelativePath: input["release-passport-relative-path"] });
}
const input = (core, name) => core.getInput(name, { required: true });
function runtime(core) { verifyCheckoutIdentity({ directory: installationRoot(import.meta.url), sha: input(core, "runtime-sha"), label: "Attester runtime" }); }
export function prepareAttestationAction(core, env) {
 runtime(core);
 const outputs = prepareAttestation({ subjectPath: input(core, "subject-path"), platformManifestPath: input(core, "platform-manifest-path"), releasePassportPath: input(core, "release-passport-path"),
  policy: JSON.parse(input(core, "policy-json")), expectedBuildchainRef: input(core, "runtime-sha"), expectedCallerRepository: env.GITHUB_REPOSITORY, expectedSourceSha: env.GITHUB_SHA,
  outputDir: path.join(env.GITHUB_WORKSPACE, ".buildchain/github-artifact-attestation") });
 for (const [key, value] of Object.entries(outputs)) core.setOutput(key, value);
}
export function sealAttestationAction(core, env) {
 runtime(core);
 const outputs = sealAttestation({ runtimeSha: input(core, "runtime-sha"), sourceSha: env.GITHUB_SHA, outputDir: path.join(env.GITHUB_WORKSPACE, ".buildchain/github-artifact-attestation"), preparation: JSON.parse(input(core, "preparation-json")),
  bundlePath: input(core, "bundle-path"), attestationId: input(core, "attestation-id"), attestationUrl: input(core, "attestation-url"), token: input(core, "token"), environment: env,
  workflow: { repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB, url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` } });
 for (const [key, value] of Object.entries(outputs)) core.setOutput(key, value);
}
