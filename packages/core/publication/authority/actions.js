import path from "node:path";
import { publicationAuthorityRequest } from "./request.js";
import { admitPublicationAuthorityRequest } from "./admission.js";
import { verifyLivePublicationGovernance } from "./governance.js";
import { referencedControllerArtifact } from "./evidence.js";
import { assembleConsumerGate } from "./consumer-gate.js";
import { assemblePublicationAdmission } from "./assembly.js";
import { qualifyPublicationAuthority } from "./result.js";
import { installationRoot } from "../../runtime/installation-root.js";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";
const parse = (value) => (value ? JSON.parse(value) : undefined);
function context(core, env) {
  const request = publicationAuthorityRequest(
    JSON.parse(core.getInput("request-json", { required: true })),
    JSON.parse(env.BUILDCHAIN_RUNTIME_SELECTION),
  );
  return {
    request: { ...request, callerRepository: env.GITHUB_REPOSITORY },
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    runtimeRoot: installationRoot(import.meta.url),
  };
}
export function inspectPublicationAuthorityAction(core, env) {
  admitPublicationAuthorityRequest(context(core, env).request);
}
export function verifyPublicationGovernanceAction(
  core,
  env,
  { verify = verifyLivePublicationGovernance } = {},
) {
  const { request, workspace, runtimeRoot } = context(core, env);
  return verify({
    repository: request.evidenceRepository || env.GITHUB_REPOSITORY,
    targetRef: request.targetRef,
    runtimeSha: request.runtimeSha,
    runtimeRoot,
    outputRoot: path.join(workspace, ".buildchain/publication-authority"),
    token: core.getInput("token", { required: true }),
  });
}
export function locateAuthorityControllerAction(core, env) {
  core.setOutput(
    "controller-artifact",
    referencedControllerArtifact(
      path.join(env.GITHUB_WORKSPACE, ".buildchain/publication-evidence"),
    ),
  );
}
export async function qualifyAuthorityConsumerGateAction(core, env) {
  const { request, workspace, runtimeRoot } = context(core, env);

  const subjectRoot = path.join(
      workspace,
      ".buildchain/publication-consumer-source",
    ),
    controllerRoot = request.consumerGateControllerSha
      ? path.join(workspace, ".buildchain/publication-consumer-controller")
      : "";
  verifyCheckoutIdentity({
    directory: subjectRoot,
    sha: request.sourceSha,
    label: "Consumer Gate subject",
  });
  if (controllerRoot)
    verifyCheckoutIdentity({
      directory: controllerRoot,
      sha: request.consumerGateControllerSha,
      label: "Consumer Gate controller",
    });
  const resultPath = path.join(
    workspace,
    ".buildchain/publication-authority/consumer-gate-aggregate.json",
  );
  const environment = {
    ...env,
    BUILDCHAIN_CONSUMER_GATE_COMMAND: request.consumerGateCommand,
    BUILDCHAIN_PUBLICATION_CONSUMER_CONTROLLER_SHA:
      request.consumerGateControllerSha || "",
    BUILDCHAIN_PUBLICATION_CONSUMER_CONTROLLER_REPOSITORY:
      env.GITHUB_REPOSITORY,
    BUILDCHAIN_PUBLICATION_SUBJECT_ROOT: subjectRoot,
    BUILDCHAIN_PUBLICATION_EVIDENCE_ROOT: path.join(
      workspace,
      ".buildchain/publication-evidence",
    ),
    BUILDCHAIN_PUBLICATION_GATE_RESULT_PATH: resultPath,
    BUILDCHAIN_PUBLICATION_AUTHORITY_RUNTIME_ROOT: runtimeRoot,
    BUILDCHAIN_PUBLICATION_SOURCE_SHA:
      request.consumerGateEvidenceSourceSha || request.sourceSha,
    BUILDCHAIN_PUBLICATION_TARGET_SOURCE_SHA: request.sourceSha,
    BUILDCHAIN_PUBLICATION_EVIDENCE_SOURCE_TREE:
      request.consumerGateEvidenceSourceTree || "",
    BUILDCHAIN_PUBLICATION_TARGET_REF: request.targetRef,
    BUILDCHAIN_PUBLICATION_EVIDENCE_RUN_ID: String(request.evidenceRunId),
  };
  const aggregate = await assembleConsumerGate({
    resultPath,
    subjectRoot,
    controllerRoot,
    command: request.consumerGateCommand,
    environment,
    controllerSha: request.consumerGateControllerSha,
    repository: env.GITHUB_REPOSITORY,
    targetSourceSha: request.sourceSha,
    evidenceSourceSha:
      request.consumerGateEvidenceSourceSha || request.sourceSha,
    evidenceSourceTree: request.consumerGateEvidenceSourceTree,
  });
  core.setOutput("gate-aggregate-json", JSON.stringify(aggregate));
}
export async function assemblePublicationAdmissionAction(core, env) {
  const input = context(core, env);
  if (input.request.dryRun || !input.request.autoAdmission) return;
  input.request.gateAggregate = parse(
    core.getInput("consumer-gate-json") || input.request.gateAggregateJson,
  );
  const bundle = await assemblePublicationAdmission({
    ...input,
    token: core.getInput("token", { required: true }),
    governanceToken: core.getInput("governance-token", { required: true }),
    apiUrl: env.GITHUB_API_URL,
    runner: {
      os: env.RUNNER_OS,
      architecture: env.RUNNER_ARCH,
      imageOs: env.ImageOS,
      imageVersion: env.ImageVersion,
      workflow: env.GITHUB_WORKFLOW,
      job: env.GITHUB_JOB,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      environment: env.RUNNER_ENVIRONMENT,
    },
  });
  core.setOutput("admission-bundle-json", JSON.stringify(bundle));
}
export async function qualifyPublicationAuthorityAction(core, env) {
  const input = context(core, env),
    { request } = input,
    bundle = parse(core.getInput("admission-bundle-json")) || {};
  const outputs = await qualifyPublicationAuthority({
    ...input,
    token: core.getInput("token", { required: true }),
    apiUrl: env.GITHUB_API_URL,
    admission: parse(request.admissionJson) || bundle.admission,
    runnerProvenance:
      parse(request.runnerProvenanceJson) || bundle.runner_provenance,
    controlPlaneAudit:
      parse(request.controlPlaneAuditJson) || bundle.control_plane_audit,
    gateAggregate:
      parse(core.getInput("consumer-gate-json") || request.gateAggregateJson) ||
      bundle.gate_aggregate,
    expected: parse(request.expectedJson) || bundle.expected,
    usedNonces: parse(request.usedNoncesJson),
  });
  for (const [key, value] of Object.entries(outputs))
    core.setOutput(key, value);
}
