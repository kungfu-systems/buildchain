import { choice, object, relativePath, text } from "./shape.js";
import { CONFIG_PATH } from "./plan.js";

export const PIPELINE_ENTRY = ".github/workflows/public-ops-pipeline.yml";
export const RECOVERY_ENTRY = ".github/workflows/public-ops-recover.yml";
export const PIPELINE_EVENTS = {
  pull_request: [
    "opened",
    "reopened",
    "synchronize",
    "ready_for_review",
    "converted_to_draft",
    "closed",
    "labeled",
    "unlabeled",
    "edited",
    "enqueued",
    "dequeued",
  ],
  pull_request_review: ["submitted", "dismissed"],
  pull_request_target: ["closed"],
  merge_group: ["checks_requested"],
  push: [],
  repository_dispatch: ["buildchain-attempt-wake"],
};

export function normalInputs(value = {}) {
  object(value, [], ["config-path"], "inputs");
  const configPath = relativePath(
    value["config-path"] ?? CONFIG_PATH,
    "inputs.config-path",
  );
  if (!configPath.endsWith(".toml") || configPath.includes("*"))
    throw new Error("inputs.config-path: expected one TOML path");
  return { configPath };
}

export function recoveryInputs(value) {
  object(value, ["attempt"], ["runtime-ref"], "inputs");
  text(value.attempt, "inputs.attempt", /^attempt-[0-9a-f]{64}$/u);
  const runtimeRef = value["runtime-ref"] ?? "";
  if (runtimeRef !== "")
    text(
      runtimeRef,
      "inputs.runtime-ref",
      /^(?:[0-9a-f]{40}|v4(?:-alpha)?|train\/v4\/v4\.[0-9]+\/[a-z0-9][a-z0-9-]*)$/u,
    );
  return { attempt: value.attempt, runtimeRef };
}

export function admitEvent(name, action = "") {
  choice(name, Object.keys(PIPELINE_EVENTS), "event.name");
  choice(
    action,
    PIPELINE_EVENTS[name].length ? PIPELINE_EVENTS[name] : [""],
    "event.action",
  );
  return { name, action };
}

function call(entry, channel, extra = "") {
  return `permissions:\n  contents: read\njobs:\n  buildchain:\n    uses: kungfu-systems/buildchain/${entry}@${channel}\n${extra}    secrets: inherit\n    permissions:\n      actions: write\n      checks: write\n      contents: write\n      discussions: write\n      id-token: write\n      pull-requests: write\n      statuses: write\n`;
}

// Product-independent source of the two caller bytes. Public entry publication
// is qualified separately; rendering this contract is not an execution receipt.
export function consumerWorkflows(channel = "v4", configPath = CONFIG_PATH) {
  choice(channel, ["v4", "v4-alpha"], "entry.channel");
  normalInputs({ "config-path": configPath });
  const configInput =
    configPath === CONFIG_PATH
      ? ""
      : `    with:\n      config-path: ${configPath}\n`;
  const events = Object.entries(PIPELINE_EVENTS)
    .map(([name, types]) => {
      return types.length
        ? `  ${name}:\n    types: [${types.join(", ")}]\n`
        : `  ${name}:\n`;
    })
    .join("");
  return {
    ".github/workflows/buildchain.yml": `name: Buildchain pipeline\non:\n${events}${call(PIPELINE_ENTRY, channel, configInput)}`,
    ".github/workflows/buildchain-recover.yml": `name: Buildchain recovery\non:\n  workflow_dispatch:\n    inputs:\n      attempt:\n        description: Exact Buildchain attempt to recover\n        required: true\n        type: string\n      runtime-ref:\n        description: Optional repaired runtime\n        required: false\n        type: string\n${call(RECOVERY_ENTRY, channel, "    with:\n      attempt: ${{ inputs.attempt }}\n      runtime-ref: ${{ inputs.runtime-ref }}\n")}`,
  };
}
