import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveBuildConfiguration } from "./resolve-build-configuration.mjs";
import { resolveRunnerMatrix } from "./build-contract-core.mjs";
import { resolveArtifactTransferMode } from "./resolve-artifact-transfer-mode.mjs";
import { reportBuildchainIssue } from "../../governance/issue-reporting.js";
import { commonEnv, main, output, readJson, rootOf, runtimeRoot, script, sourceRoot, writeJson } from "./context.mjs";

export function buildMatrices(plan, resolved) {
  const platforms = JSON.parse(resolved.platformsJson);
  const credential = plan.build.macos_signing;
  if (credential.app_path && !platforms.some((p) => p.id === credential.platform && p.platform === "macos")) throw new Error("macOS signing platform is not a declared macOS lane");
  if (credential.app_path && !plan.environment.signing.environment) throw new Error("macOS signing requires a governed credential environment");
  if (plan.build.finalization.on_platform && platforms.some((p) => !p.githubHosted)) throw new Error("Platform finalization requires GitHub-hosted runners");
  if (plan.build.attestation.subject_path && !platforms.some((p) => p.id === plan.build.attestation.platform)) throw new Error("Attestation platform is not declared");
  const annotate = (p) => ({ ...p, runner: p.provider === "aws-codebuild"
    ? [`codebuild-${p.project}-${plan.run.id}-${plan.run.attempt}`] : JSON.parse(p.runner) });
  return {
    platforms: platforms.map(annotate),
    matrix: {
      native: JSON.parse(resolved.nativePlatformsJson).map(annotate),
      container: JSON.parse(resolved.containerPlatformsJson).map(annotate),
      sign: [
        ...platforms.map((p) => ({ id: p.id, kind: "artifact", runner: plan.build.finalization.on_platform ? JSON.parse(p.runner) : ["ubuntu-24.04"], environment: "" })),
        ...(credential.app_path ? [{ id: credential.platform, kind: "credential", runner: ["macos-15"], environment: plan.environment.signing.environment }] : []),
      ],
    },
    container: resolved.linuxContainer,
  };
}

export async function resolvePlan() {
  const event = process.env.GITHUB_EVENT_PATH ? readJson(process.env.GITHUB_EVENT_PATH) : {};
  if (process.env.GITHUB_EVENT_NAME === "pull_request" && event.pull_request?.head?.repo?.full_name !== process.env.GITHUB_REPOSITORY) throw new Error("Untrusted source cannot reach build runners");
  const { plan } = resolveBuildConfiguration({ root: sourceRoot, locator: process.env.BUILDCHAIN_CONFIG_PATH || "",
    workflowRef: process.env.BUILDCHAIN_WORKFLOW_REF, workflowSha: process.env.BUILDCHAIN_WORKFLOW_SHA,
    repository: "kungfu-systems/buildchain", sourceSha: process.env.GITHUB_SHA, sourceRef: process.env.GITHUB_REF,
    callerWorkflowRef: process.env.GITHUB_WORKFLOW_REF, eventName: process.env.GITHUB_EVENT_NAME, baseRef: process.env.GITHUB_BASE_REF });
  const git = (...args) => execFileSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== plan.source.sha) throw new Error("Checked out source differs from invocation");
  plan.source.tree_sha = git("rev-parse", "HEAD^{tree}");
  plan.run = { repository: process.env.GITHUB_REPOSITORY, id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  const policy = await script("packages/core/consumer/commands/consumer-policy.mjs", {
    BUILDCHAIN_CONSUMER_ROOT: sourceRoot, BUILDCHAIN_INVOKED_WORKFLOW: plan.identity.visible_workflow,
    BUILDCHAIN_EXPECTED_INVOCATION_CHANNEL: plan.identity.channel,
    BUILDCHAIN_WORKFLOW_SHA: plan.identity.sha, BUILDCHAIN_RUNTIME_SHA: plan.identity.sha,
    BUILDCHAIN_STABLE_CONTRACT_LOCK_PATH: ".buildchain/contract-lock.json", BUILDCHAIN_ALPHA_CONTRACT_LOCK_PATH: ".buildchain/alpha-contract-lock.json",
    BUILDCHAIN_V4_POLICY_RECEIPT_PATH: ".buildchain/evidence/consumer-policy-receipt.json",
  }, ["scan"]);
  await script("packages/core/build/commands/validate-package-manager-contract.mjs", { BUILDCHAIN_PACKAGE_MANAGER_CWD: sourceRoot });
  let lockFailure;
  const lock = await script("packages/core/contracts/commands/buildchain-contract-lock.mjs", {
    BUILDCHAIN_CONTRACT_LOCK_PATH: path.join(sourceRoot, plan.contract.lock_path),
    BUILDCHAIN_CONTRACT_COMPATIBILITY_POLICY: plan.build.contract.compatibility_policy,
    BUILDCHAIN_CONTRACT_DRIFT_ISSUE_MODE: plan.build.contract.drift_issue_mode,
    BUILDCHAIN_RUNTIME_ROOT: runtimeRoot, BUILDCHAIN_RUNTIME_REF: plan.identity.ref, BUILDCHAIN_RUNTIME_SHA: plan.identity.sha,
    BUILDCHAIN_RUNTIME_CLASS: plan.identity.channel, BUILDCHAIN_WORKFLOW_SHELL_REF: plan.identity.ref,
    BUILDCHAIN_EXPECTED_CHANNEL: plan.identity.channel, BUILDCHAIN_EXPECTED_MAJOR: plan.identity.major,
    BUILDCHAIN_ALLOW_OPAQUE_RUNTIME: false,
  }, ["check"]).catch((error) => { lockFailure = error; return error.outputs || {}; });
  plan.admission = { policy: JSON.parse(policy["v4-consumer-policy-receipt-json"]), policy_root: policy["v4-consumer-policy-receipt-root"],
    contract_digest: lock["contract-digest"], lock_status: lock["contract-lock-status"] };
  if (lock["contract-lock-issue-needed"] === "true") {
    try {
      await reportBuildchainIssue({ token: process.env.GITHUB_TOKEN, targetRepository: plan.run.repository,
        title: `[Buildchain contract] ${plan.run.repository} drift on ${plan.identity.ref}`,
        summary: `Buildchain contract drift: ${plan.admission.lock_status}`, failureCode: `buildchain-contract-${plan.admission.lock_status}`,
        buildchainRef: plan.identity.ref, buildchainVersion: plan.admission.contract_digest, consumerRepository: plan.run.repository,
        consumerRef: plan.source.ref, consumerSha: plan.source.sha, workflow: process.env.GITHUB_WORKFLOW,
        runId: plan.run.id, body: fs.readFileSync(lock["contract-lock-issue-body-file"], "utf8"), labels: "buildchain-contract-drift", commentCooldownHours: 24 });
    } catch { console.warn("::warning::Contract drift report could not be submitted"); }
  }
  if (lockFailure) throw lockFailure;
  const source = await script("packages/core/release/commands/resolve-publish-source.mjs", { ...commonEnv(plan), BUILDCHAIN_PUBLISH_SOURCE_SHA: plan.source.sha }, ["--mode", "lock"]);
  await script("packages/core/release/commands/verify-publish-channel-ref.mjs", { BUILDCHAIN_PUBLISH_SOURCE_REF: source["publish-source-ref"], BUILDCHAIN_PUBLISH_SOURCE_SHA: plan.source.sha, BUILDCHAIN_SOURCE_REPOSITORY: plan.run.repository });
  const manifest = await script("packages/core/release/commands/resolve-publish-source.mjs", { ...commonEnv(plan), BUILDCHAIN_SOURCE_CWD: path.join(sourceRoot, plan.project.cwd),
    BUILDCHAIN_PUBLISH_SOURCE_REF: source["publish-source-ref"], BUILDCHAIN_PUBLISH_SOURCE_SHA: plan.source.sha,
    BUILDCHAIN_RELEASE_MANIFEST: ".buildchain/plan/publish-source-manifest.json" }, ["--mode", "manifest"]);
  plan.source.release = { ref: source["publish-source-ref"], channel: source["publish-source-channel"], line: source["publish-source-line"],
    version: manifest["publish-source-consumer-version"], locked: source["publish-source-locked"] === "true", manifest: JSON.parse(manifest["release-manifest-json"]) };
  const line = plan.source.release.line;
  const target = process.env.GITHUB_BASE_REF || (/^v\d+\/v\d+\.\d+$/u.test(line) ? `release/${line}` : /^v(\d+)\.(\d+)$/u.test(line) ? `release/v${line.slice(1).split(".")[0]}/${line}` : "");
  plan.anchored_material = { target_channel: plan.source.release.channel, target_ref: target };
  let runners = resolveRunnerMatrix({ runnerPreset: plan.environment.runners.preset, platformsJson: plan.environment.runners.platforms_json,
    awsCodeBuildProject: plan.environment.runners.codebuild_project, awsEc2WindowsRunnerLabel: plan.environment.runners.windows_label,
    awsEc2MacosRunnerLabel: plan.environment.runners.macos_label, linuxContainerPreset: plan.environment.runners.container_preset,
    linuxContainerImage: plan.environment.runners.container_image });
  if (plan.environment.runners.offline_fallback) {
    const routing = await script("packages/core/providers/commands/route-offline-runners.mjs", { BUILDCHAIN_RUNNER_PRESET: "custom", BUILDCHAIN_PLATFORMS_JSON: runners.platformsJson,
      BUILDCHAIN_RUNNER_INVENTORY_TOKEN: process.env.BUILDCHAIN_CONTROL_TOKEN });
    runners = resolveRunnerMatrix({ runnerPreset: "custom", platformsJson: routing["platforms-json"], linuxContainerPreset: plan.environment.runners.container_preset, linuxContainerImage: plan.environment.runners.container_image });
    plan.routing = JSON.parse(routing["routing-json"]);
  }
  Object.assign(plan, buildMatrices(plan, runners));
  plan.transfer = resolveArtifactTransferMode({ INPUT_TRANSFER_MODE: plan.environment.transfer.mode, INPUT_RELAY_REQUIRED: String(runners.relayPlatformCount > 0),
    INPUT_S3_BUCKET: plan.environment.transfer.bucket, INPUT_S3_REGION: plan.environment.transfer.region, INPUT_S3_PREFIX: plan.environment.transfer.prefix,
    INPUT_S3_UPLOAD_ROLE_ARN: plan.environment.transfer.upload_role_arn,
    INPUT_S3_DOWNLOAD_ROLE_ARN: plan.environment.transfer.download_role_arn,
    INPUT_OIDC_AUDIENCE: plan.environment.transfer.oidc_audience });
  const controller = await script("packages/core/observability/commands/controller-evidence.mjs", { BUILDCHAIN_CONTROLLER_ID: "build-lifecycle", BUILDCHAIN_CONTROLLER_SOURCE_REPOSITORY: plan.run.repository,
    BUILDCHAIN_CONTROLLER_SOURCE_SHA: plan.source.sha, BUILDCHAIN_CONTROLLER_RUNTIME_REF: plan.identity.ref, BUILDCHAIN_CONTROLLER_RUNTIME_SHA: plan.identity.sha,
    BUILDCHAIN_CONTROLLER_CONTRACT_DIGEST: plan.admission.contract_digest, BUILDCHAIN_CONTROLLER_REGISTRY: path.join(runtimeRoot, "dist/site/controller-registry.json"),
    BUILDCHAIN_CONTROLLER_INPUTS_JSON: JSON.stringify({ "configuration-root": plan.configuration_root }), BUILDCHAIN_CONTROLLER_INPUT_BOUNDARY: "strict",
    BUILDCHAIN_CONTROLLER_PLAN_PATH: ".buildchain/plan/controller.json" }, ["--mode", "plan"]);
  plan.controller = JSON.parse(controller["controller-plan-json"]);
  plan.root = rootOf(plan);
  writeJson(".buildchain/plan/plan.json", plan);
  output("plan", plan);
}
main(import.meta.url, resolvePlan);
