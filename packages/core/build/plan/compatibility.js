import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";

const contract = JSON.parse(
  fs.readFileSync(
    path.join(
      installationRoot(import.meta.url),
      "contracts/fixtures/consumer-upgrade/build-v4.0.0.json",
    ),
    "utf8",
  ),
);
const bindings =
  JSON.parse(
    fs.readFileSync(
      path.join(
        installationRoot(import.meta.url),
        "architecture/consumer-upgrade.json",
      ),
      "utf8",
    ),
  ).entries.find((entry) => entry.adapter === "build-backbone")
    ?.inputVariables || {};

// The old workflow boundary is typed before values enter the current planner.
// Empty modern calls preserve the TOML plan; historical defaults do not replace
// explicit TOML choices when GitHub expands all optional workflow inputs.
export function historicalBuildInputs(value = {}, environment = {}) {
  if (typeof value === "string") value = JSON.parse(value || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Historical build inputs must be an object");
  const current = new Set([
    "config-path",
    "runtime-ref",
    "contract-lock",
    "resume-run-id",
    "runtime-selection",
  ]);
  const result = {};
  for (const [key, input] of Object.entries(value)) {
    if (current.has(key)) continue;
    const field = contract.inputs[key];
    if (
      !field ||
      typeof input !== field.type ||
      (typeof input === "number" && !Number.isFinite(input))
    )
      throw new Error(`Invalid historical build input: ${key}`);
    if (input !== field.default) result[key] = input;
  }
  if (Object.keys(value).some((key) => Object.hasOwn(contract.inputs, key)))
    for (const key of Object.keys(bindings)) {
      const selected =
        environment[
          `BUILDCHAIN_HISTORICAL_${key.replaceAll("-", "_").toUpperCase()}`
        ];
      if (selected && !value[key]) result[key] = String(selected);
    }
  return result;
}

const paths = {
  "runner-preset": "environment.runners.preset",
  "platforms-json": "environment.runners.platforms_json",
  "control-runner-json": "environment.runners.control_json",
  "aws-codebuild-project": "environment.runners.codebuild_project",
  "aws-ec2-windows-runner-label": "environment.runners.windows_label",
  "aws-ec2-macos-runner-label": "environment.runners.macos_label",
  "self-hosted-offline-fallback": "environment.runners.offline_fallback",
  "linux-container-preset": "environment.runners.container_preset",
  "linux-container-image": "environment.runners.container_image",
  "rustup-dist-server": "environment.tools.rustup_dist_server",
  "rustup-update-root": "environment.tools.rustup_update_root",
  "cargo-registry-index": "environment.tools.cargo_registry_index",
  "checkout-cache-mode": "environment.checkout.mode",
  "checkout-cache-mirror-url-template":
    "environment.checkout.mirror_url_template",
  "checkout-cache-reference-repository-template":
    "environment.checkout.reference_repository_template",
  "checkout-cache-fallback": "environment.checkout.fallback",
  "checkout-cache-timeout-seconds": "environment.checkout.timeout_seconds",
  "checkout-cache-github-timeout-seconds":
    "environment.checkout.github_timeout_seconds",
  "checkout-cache-fetch-attempts": "environment.checkout.fetch_attempts",
  "checkout-history-mode": "environment.checkout.history_mode",
  "artifact-transfer-mode": "environment.transfer.mode",
  "artifact-relay-s3-bucket": "environment.transfer.bucket",
  "artifact-relay-s3-region": "environment.transfer.region",
  "artifact-relay-s3-prefix": "environment.transfer.prefix",
  "artifact-relay-s3-upload-role-arn": "environment.transfer.upload_role_arn",
  "artifact-relay-s3-download-role-arn":
    "environment.transfer.download_role_arn",
  "artifact-relay-s3-oidc-audience": "environment.transfer.oidc_audience",
  "shifu-cache-profile-ref": "environment.cache.profile_ref",
  "shifu-cache-profile-digest": "environment.cache.profile_digest",
  "compiler-cache-provider": "environment.cache.provider",
  "compiler-cache-platforms-json": "environment.cache.platforms_json",
  "compiler-cache-required": "environment.cache.required",
  "artifact-signing-request-upload-no-proxy":
    "environment.signing.upload_no_proxy",
  "credential-island-environment": "environment.signing.environment",
  "fail-fast": "build.fail_fast",
  "lifecycle-timeout-minutes": "build.timeout_minutes",
  "artifact-retention-days": "build.artifacts.retention_days",
  "artifact-compression-level": "build.artifacts.compression_level",
  "release-candidate": "build.artifacts.release_candidate",
  "artifact-finalization-command": "build.finalization.command",
  "artifact-finalization-on-platform": "build.finalization.on_platform",
  "verify-substage-evidence-path": "build.verification.substage_evidence_path",
  "pre-upload-transport-smoke-scenario-path":
    "build.transport_smoke.scenario_path",
  "pre-upload-transport-smoke-artifact-root":
    "build.transport_smoke.artifact_root",
  "credential-island-macos-app-path": "build.macos_signing.app_path",
  "credential-island-macos-platform-id": "build.macos_signing.platform",
  "github-artifact-attestation-subject-path": "build.attestation.subject_path",
  "github-artifact-attestation-platform-id": "build.attestation.platform",
  "sample-process-tree": "build.diagnostics.sample_process_tree",
  "process-sample-interval-ms": "build.diagnostics.sample_interval_ms",
  "requested-parallelism": "build.diagnostics.requested_parallelism",
  "buildchain-contract-compatibility-policy":
    "build.contract.compatibility_policy",
  "buildchain-contract-drift-issue-mode": "build.contract.drift_issue_mode",
};

export function applyHistoricalBuildInputs(plan, inputs) {
  const remaining = { ...inputs };
  for (const [input, field] of Object.entries(paths)) {
    if (!Object.hasOwn(remaining, input)) continue;
    const names = field.split(".");
    const key = names.pop();
    const target = names.reduce((value, name) => value[name], plan);
    target[key] = remaining[input];
    delete remaining[input];
  }
  for (const stage of ["install", "build", "verify"]) {
    if (Object.hasOwn(remaining, `${stage}-command`)) {
      plan.lifecycle[stage].command = remaining[`${stage}-command`];
      plan.lifecycle[stage].configured = Boolean(remaining[`${stage}-command`]);
      delete remaining[`${stage}-command`];
    }
    if (Object.hasOwn(remaining, `require-${stage}`)) {
      plan.lifecycle[stage].required = remaining[`require-${stage}`];
      delete remaining[`require-${stage}`];
    }
  }
  for (const [input, tool] of [
    ["node-version", "node"],
    ["rust-toolchain", "rust"],
  ]) {
    if (Object.hasOwn(remaining, input)) {
      plan.tools[tool] = plan.build.tools[tool] = remaining[input];
      delete remaining[input];
    }
    if (Object.hasOwn(remaining, `setup-${tool}`)) {
      plan.tools[`setup_${tool}`] = remaining[`setup-${tool}`];
      delete remaining[`setup-${tool}`];
    }
  }
  return remaining;
}
