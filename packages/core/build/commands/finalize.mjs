import fs from "node:fs";
import path from "node:path";
import { artifactNames, verifyExecutionIdentity, verifyExecution, verifyCredential } from "./artifact-contract.mjs";
import { loadFinalArtifact } from "./attest.mjs";
import { download, lookup, publishRecord, readRecord, upload, validateReference } from "./artifact-store.mjs";
import { resolveArtifactCoordinates } from "./resolve-artifact-coordinates.mjs";
import { commonEnv, context, main, output, readJson, rootOf, script, workspace, writeJson } from "./context.mjs";

export function assertJobResults(jobs, plan) {
  for (const [name, enabled] of [["build-native", plan.matrix.native.length > 0], ["build-container", plan.matrix.container.length > 0], ["sign", true], ["attest", Boolean(plan.build.attestation.subject_path)]]) {
    const expected = enabled ? "success" : "skipped";
    if (jobs[name]?.result !== expected) throw new Error(`Build job ${name}: expected ${expected}, got ${jobs[name]?.result || "missing"}`);
  }
}
async function providerArtifacts(plan) {
  const result = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${plan.run.repository}/actions/runs/${plan.run.id}/artifacts?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
    if (!response.ok) throw new Error(`Artifact coordinate readback failed: ${response.status}`);
    const { artifacts } = await response.json();
    result.push(...artifacts);
    if (artifacts.length < 100) return result;
  }
}
export function buildControllerStages(plan, jobs, executions, success) {
  const stageStatus = (id) => {
    if (!plan.lifecycle[id].configured) return "skipped";
    if (executions.some((record) => record.stages[id] === "failure")) return "failure";
    if (executions.length === plan.platforms.length && executions.every((record) => record.stages[id] === "success")) return "success";
    return executions.some((record) => record.stages[id]) ? "partial" : "skipped";
  };
  return [{ id: "plan", status: "success" },
    ...["install", "build", "verify"].map((id) => ({ id, status: stageStatus(id) })),
    { id: "sign", status: jobs.sign?.result || "skipped" }, { id: "attest", status: jobs.attest?.result || "skipped" },
    { id: "deliver", status: success ? "success" : "failure" }];
}
async function controllerReceipt(plan, jobs, success, executions = []) {
  writeJson(".buildchain/controller/plan.json", plan.controller);
  const stages = buildControllerStages(plan, jobs, executions, success);
  const result = await script("packages/core/observability/commands/controller-evidence.mjs", { BUILDCHAIN_CONTROLLER_PLAN_PATH: ".buildchain/controller/plan.json",
    BUILDCHAIN_CONTROLLER_STAGES_JSON: JSON.stringify(stages), BUILDCHAIN_CONTROLLER_RECEIPT_PATH: ".buildchain/controller/receipt.json",
    BUILDCHAIN_CONTROLLER_EVIDENCE_FILES_JSON: JSON.stringify(success ? [
      { kind: "anchored-version-material", path: ".buildchain/controller/anchored-version-material.json" },
      { kind: "platform-manifests", path: ".buildchain/artifacts/build-summary.json" },
      { kind: "build-summary", path: ".buildchain/artifacts/build-summary.json" },
    ] : []), BUILDCHAIN_CONTROLLER_REASON_CODE: success ? "" : "controller-incomplete",
    BUILDCHAIN_CONTROLLER_REASON_SUMMARY: success ? "" : "Build did not complete successfully",
    BUILDCHAIN_CONTROLLER_RECEIPT_ARTIFACT: `${plan.artifacts.name}-controller-receipt-${plan.source.sha}`,
  }, ["--mode", "receipt"]);
  return { receipt: JSON.parse(result["controller-receipt-json"]), artifact: await upload(plan, `${plan.artifacts.name}-controller-receipt-${plan.source.sha}`, ["receipt.json"], path.resolve(".buildchain/controller")) };
}
async function aggregate(plan, jobs, executions) {
  // Read all available producers before evaluating job success, so a failed
  // sibling cannot erase the completed stages from the controller receipt.
  const reads = await Promise.allSettled(plan.platforms.map(async (platform) => {
    const record = await readRecord(plan, artifactNames(plan, platform).execution, `.buildchain/executions/${platform.id}`);
    return verifyExecutionIdentity(record, plan, platform);
  }));
  for (const read of reads) if (read.status === "fulfilled") executions.push(read.value);
  assertJobResults(jobs, plan);
  for (const read of reads) if (read.status === "rejected") throw read.reason;
  for (const platform of plan.platforms) verifyExecution(executions.find((record) => record.platform === platform.id), plan, platform);
  const payloads = [];
  let anchored;
  for (const platform of plan.platforms) {
    const names = artifactNames(plan, platform);
    const directory = path.join(workspace, `.buildchain/final-artifacts/${platform.id}`);
    const { result, manifest } = await loadFinalArtifact(plan, platform, directory);
    const material = readJson(path.join(directory, `.buildchain/artifacts/${platform.id}/anchored-version-material.json`));
    if (anchored && rootOf(anchored) !== rootOf(material)) throw new Error("Platform anchored version material differs");
    anchored = material;
    payloads.push(result.payload);
    writeJson(`.buildchain/downloaded-manifests/${platform.id}/manifest.json`, manifest);
    const diagnostics = path.join(directory, `.buildchain/artifacts/${platform.id}/diagnostics.json`);
    if (!fs.existsSync(diagnostics)) throw new Error(`Missing diagnostics for ${platform.id}`);
    writeJson(`.buildchain/downloaded-diagnostics/${platform.id}/diagnostics.json`, readJson(diagnostics));
  }
  let credential;
  if (plan.build.macos_signing.app_path) {
    const platform = plan.platforms.find((p) => p.id === plan.build.macos_signing.platform);
    credential = await readRecord(plan, `${artifactNames(plan, platform).signing}-credential`, ".buildchain/credential-record");
    const { root, ...body } = credential;
    if (credential.plan_root !== plan.root || root !== rootOf(body) || credential.status !== "success") throw new Error("Invalid credential result");
    const payloadRoot = ".buildchain/credential-payload";
    await download(validateReference(credential.payload, plan), payloadRoot);
    await download(validateReference(credential.manifest, plan), ".buildchain/downloaded-manifests/credential");
    verifyCredential(".buildchain/downloaded-manifests/credential/manifest.json", payloadRoot, plan, platform);
  }
  const release = plan.source.release;
  writeJson(".buildchain/controller/anchored-version-material.json", anchored);
  const env = { ...commonEnv(plan), BUILDCHAIN_SUMMARY_INPUT: ".buildchain/downloaded-manifests", BUILDCHAIN_SUMMARY_OUTPUT: ".buildchain/artifacts/build-summary.json",
    BUILDCHAIN_PLATFORM_COUNT: plan.platforms.length, BUILDCHAIN_EXPECTED_PLATFORMS_JSON: JSON.stringify(plan.platforms),
    BUILDCHAIN_ADDITIONAL_PLATFORM_COUNT: credential ? 1 : 0, BUILDCHAIN_ADDITIONAL_PLATFORM_IDS_JSON: JSON.stringify(credential ? [`${plan.build.macos_signing.platform}-credential`] : []),
    BUILDCHAIN_TRUSTED_EVENT: true, BUILDCHAIN_PUBLISH_CHANNEL: "none", BUILDCHAIN_PUBLISH_ALLOWED: false,
    BUILDCHAIN_PUBLISH_REASON: "Build produces evidence; publication requires a release authority",
    BUILDCHAIN_PUBLISH_SOURCE_REF: release.ref, BUILDCHAIN_PUBLISH_SOURCE_SHA: plan.source.sha, BUILDCHAIN_PUBLISH_SOURCE_LOCKED: release.locked,
    BUILDCHAIN_PUBLISH_SOURCE_CHANNEL: release.channel, BUILDCHAIN_PUBLISH_SOURCE_LINE: release.line, BUILDCHAIN_PUBLISH_SOURCE_CONSUMER_VERSION: release.version,
    BUILDCHAIN_RELEASE_MANIFEST_JSON: JSON.stringify(release.manifest), BUILDCHAIN_RUNTIME_REQUESTED_REF: plan.identity.ref,
    BUILDCHAIN_RUNTIME_CLASS: plan.identity.channel, BUILDCHAIN_RUNTIME_OVERRIDE: false, BUILDCHAIN_RUNTIME_TRUST_DECISION: "workflow-identity",
    BUILDCHAIN_WORKFLOW_SHELL_REF: plan.identity.ref, BUILDCHAIN_ROLLBACK_REF: plan.identity.ref };
  await script("packages/core/build/commands/aggregate-build-summary.mjs", env);
  await script("packages/core/observability/commands/aggregate-diagnostics-summary.mjs", { BUILDCHAIN_DIAGNOSTICS_INPUT: ".buildchain/downloaded-diagnostics",
    BUILDCHAIN_DIAGNOSTICS_OUTPUT: ".buildchain/artifacts/diagnostics-summary.json", BUILDCHAIN_PLATFORM_COUNT: plan.platforms.length });
  const coordinates = resolveArtifactCoordinates({ artifacts: await providerArtifacts(plan), platforms: plan.platforms,
    artifactName: plan.artifacts.name, artifactNameTemplate: "{artifact}-final-{platform}-{sha}", sourceSha: plan.source.sha,
    sourceRef: plan.source.ref, repository: plan.run.repository, runId: plan.run.id, runAttempt: plan.run.attempt });
  for (const reference of payloads) {
    const actual = coordinates.artifacts.find((entry) => String(entry.id) === String(reference.id));
    if (!actual || actual.digest.replace(/^sha256:/u, "") !== reference.digest.replace(/^sha256:/u, "")) throw new Error("Final artifact readback mismatch");
  }
  writeJson(".buildchain/artifacts/artifact-coordinates.json", coordinates);
  return { payloads, credential, env };
}
export async function finalizeBuild() {
  const { plan } = context();
  const jobs = JSON.parse(process.env.BUILDCHAIN_JOBS);
  const executions = [];
  let aggregated;
  try { aggregated = await aggregate(plan, jobs, executions); }
  catch (error) { await controllerReceipt(plan, jobs, false, executions); throw error; }
  const controller = await controllerReceipt(plan, jobs, true, executions);
  const artifacts = { payloads: aggregated.payloads, credential: aggregated.credential || null, controller_receipt: controller.artifact };
  if (plan.build.attestation.subject_path) artifacts.attestation = validateReference(JSON.parse(jobs.attest.outputs.artifact), plan);
  if (plan.build.artifacts.release_candidate && plan.source.candidate_channel !== "none") {
    const event = process.env.GITHUB_EVENT_PATH ? readJson(process.env.GITHUB_EVENT_PATH) : {};
    await script("packages/core/publication/commands/generate-release-candidate-passport.mjs", { ...aggregated.env,
      BUILDCHAIN_BUILD_SUMMARY_PATH: ".buildchain/artifacts/build-summary.json", BUILDCHAIN_RC_PASSPORT_PATH: ".buildchain/artifacts/release-candidate-passport.json",
      BUILDCHAIN_RC_TARGET_CHANNEL: plan.source.candidate_channel, BUILDCHAIN_RC_VERSION: plan.source.release.version,
      BUILDCHAIN_RC_SOURCE_HEAD_SHA: plan.source.sha, BUILDCHAIN_RC_MERGE_REF_SHA: plan.source.sha, BUILDCHAIN_RC_SOURCE_TREE_HASH: plan.source.tree_sha,
      BUILDCHAIN_WORKFLOW_RUN_URL: `${process.env.GITHUB_SERVER_URL}/${plan.run.repository}/actions/runs/${plan.run.id}`,
      BUILDCHAIN_GATE_PROFILE_AGGREGATE_JSON: plan.evidence.gate_profile_json, BUILDCHAIN_RC_FAMILY_EVIDENCE_JSON: plan.evidence.candidate_family_json,
      BUILDCHAIN_V4_POLICY_RECEIPT_JSON: JSON.stringify(plan.admission.policy), BUILDCHAIN_V4_POLICY_RECEIPT_ROOT: plan.admission.policy_root,
      BUILDCHAIN_CONTROLLER_RECEIPT_JSON: JSON.stringify(controller.receipt), BUILDCHAIN_PULL_REQUEST_NUMBER: event.pull_request?.number || "",
      BUILDCHAIN_PULL_REQUEST_URL: event.pull_request?.html_url || "", BUILDCHAIN_PULL_REQUEST_HEAD_REF: event.pull_request?.head?.ref || "",
      BUILDCHAIN_PULL_REQUEST_BASE_REF: event.pull_request?.base?.ref || "" });
    artifacts.release_candidate = await upload(plan, `${plan.artifacts.name}-release-candidate-${plan.source.sha}`, ["release-candidate-*.json"], path.resolve(".buildchain/artifacts"));
  }
  artifacts.summary = await upload(plan, `${plan.artifacts.name}-summary-${plan.source.sha}`, ["build-summary.json", "artifact-coordinates.json"], path.resolve(".buildchain/artifacts"));
  artifacts.diagnostics = await upload(plan, `${plan.artifacts.name}-diagnostics-summary-${plan.source.sha}`, ["diagnostics-summary.json"], path.resolve(".buildchain/artifacts"));
  const result = { schema: "buildchain.build-result/v1", status: "success", plan_root: plan.root, source: plan.source, runtime: plan.identity, artifacts };
  const rooted = { ...result, root: rootOf(result) };
  await publishRecord(plan, `${plan.artifacts.name}-result-${plan.source.sha}`, rooted, ".buildchain/result");
  output("result", rooted);
}
main(import.meta.url, finalizeBuild);
