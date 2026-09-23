import fs from "node:fs";
import { resolvePublishGate } from "../../release/promotion/publish-gate.js";
import path from "node:path";
import { historicalEntrySelection } from "../../runtime/entry/compatibility.js";
import {
  containedBuildPath,
  normalizeBuildConfiguration,
} from "../build-configuration.js";
import { applyHistoricalBuildInputs } from "./compatibility.js";
import { historicalBuildArtifacts } from "./compatibility-artifacts.js";
import { rootOf } from "./values.js";

export function historicalBuildLocator(root, locator, inputs) {
  const directory = inputs["working-directory"];
  if (!directory || directory === ".") return locator;
  containedBuildPath(root, directory);
  if (locator)
    throw new Error(
      "config-path cannot be combined with a historical working-directory",
    );
  const candidates = [".buildchain/buildchain.toml", "buildchain.toml"].map(
    (item) => path.posix.join(directory, item),
  );
  const present = candidates.filter((item) =>
    fs.existsSync(containedBuildPath(root, item)),
  );
  if (present.length !== 1)
    throw new Error(
      "Historical working-directory must contain one buildchain.toml",
    );
  return present[0];
}

function applySelectors(plan, remaining) {
  const selection = historicalEntrySelection(
    remaining,
    `${plan.identity.repository}/${plan.identity.visible_workflow}@${plan.identity.ref}`,
  );
  plan.contract.lock_path = selection.lockPath;
  plan.contract.stable_lock_path = selection.stableLock;
  plan.contract.alpha_lock_path = selection.alphaLock;
  for (const [input, expected] of [
    ["buildchain-expected-channel", plan.identity.channel],
    ["buildchain-expected-major", plan.identity.major],
  ])
    if (remaining[input] && remaining[input] !== expected)
      throw new Error(`Historical ${input} does not match the called entry`);
  for (const input of [
    "buildchain-channel",
    "buildchain-ref",
    "buildchain-repository",
    "buildchain-contract-lock-path",
    "buildchain-stable-contract-lock-path",
    "buildchain-alpha-contract-lock-path",
    "buildchain-expected-channel",
    "buildchain-expected-major",
    "working-directory",
  ])
    delete remaining[input];
}

export function finishHistoricalBuildPlan(plan, inputs, root) {
  if (!Object.keys(inputs).length) return;
  const remaining = historicalBuildArtifacts(
    plan,
    applyHistoricalBuildInputs(plan, inputs),
    root,
  );
  applySelectors(plan, remaining);
  if (Object.hasOwn(remaining, "publish-channel")) {
    const channel = remaining["publish-channel"];
    plan.source.candidate_channel = channel === "major" ? "release"
      : ["alpha", "release"].includes(channel) ? channel : "none";
    delete remaining["publish-channel"];
  }
  delete remaining["publish-refs-json"];
  if (remaining["artifact-relay-s3-role-arn"]) {
    for (const kind of ["upload", "download"])
      plan.environment.transfer[`${kind}_role_arn`] ||=
        remaining["artifact-relay-s3-role-arn"];
    delete remaining["artifact-relay-s3-role-arn"];
  }
  for (const [input, field] of [
    ["gate-profile-aggregate-json", "gate_profile_json"],
    ["release-candidate-family-evidence-json", "candidate_family_json"],
  ]) {
    if (!Object.hasOwn(remaining, input)) continue;
    JSON.parse(remaining[input]);
    plan.evidence[field] = remaining[input];
    delete remaining[input];
  }
  if (Object.keys(remaining).length)
    throw new Error(
      `Unmapped historical build inputs: ${Object.keys(remaining).join(", ")}`,
    );
  plan.build = normalizeBuildConfiguration(plan.build);
  plan.configuration_root = rootOf({ toml: plan.configuration_root, inputs });
  plan.environment_root = rootOf(plan.environment);
  plan.cache.toolchain_root = rootOf({
    tools: plan.build.tools,
    environment: plan.environment.tools,
  });
  plan.cache.policy_root = rootOf(plan.environment.cache);
}

export function historicalPublishGate(plan, inputs, eventName) {
  if (plan.identity.visible_workflow !== ".github/workflows/build.yml") return;
  const resolved = resolvePublishGate({
    trusted: true,
    publishChannel: inputs["publish-channel"] || "none",
    publishRefsJson: inputs["publish-refs-json"] || "",
    eventName,
    ref: plan.source.ref,
  });
  plan.historical_publish_gate = {
    trustedEvent: resolved.trusted,
    channel: resolved.publishChannel,
    allowed: resolved.publishAllowed,
    reason: resolved.publishReason,
  };
}
