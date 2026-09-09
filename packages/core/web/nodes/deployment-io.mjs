import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { command, requireValue } from "../../runtime/action-process.mjs";

export function writeOutputs(env, values) {
  requireValue(
    Object.values(values).every((value) => !/[\r\n]/.test(String(value))),
    "Workflow scalar outputs must not contain line breaks",
  );
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
export function exactWebPlan(directory, filename) {
  const matches = fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === filename)
    .map((entry) => path.join(entry.parentPath, entry.name));
  requireValue(
    matches.length === 1,
    `Expected exactly one ${filename}, found ${matches.length}`,
  );
  return matches[0];
}
export function selectWebOutputs() {
  const plans = ["preview", "staging", "production", "cleanup"]
    .map((channel) => ({
      channel,
      file: `.buildchain/web-surface-${channel}-plan.json`,
    }))
    .filter(({ file }) => fs.existsSync(file));
  requireValue(
    plans.length <= 1,
    "Multiple Web channel plans cannot select one result",
  );
  if (!plans.length) return {};
  const { channel, file } = plans[0];
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  if (channel === "cleanup")
    return { "web-surface-cleanup-plan-json": JSON.stringify(plan) };
  return {
    "web-surface-channel": plan.channel || "",
    "web-surface-alias": plan.alias || "",
    "web-surface-url": plan.url || "",
    "web-surface-urls-json": JSON.stringify(plan.urls || {}),
    "web-surface-manifest-json": JSON.stringify(plan.manifest || {}),
  };
}
export function deploymentArguments(env, operation) {
  const channel = env.BUILDCHAIN_WEB_CHANNEL;
  requireValue(
    ["preview", "staging", "production", "cleanup"].includes(channel),
    "Unknown Web deployment channel",
  );
  requireValue(
    ["deploy", "cleanup", "preflight", "health"].includes(operation),
    "Unknown Web deployment operation",
  );
  requireValue(
    (operation !== "cleanup" || channel === "cleanup") &&
      (operation !== "preflight" || channel === "production"),
    "Web operation does not match its channel",
  );
  const input = JSON.parse(env.BUILDCHAIN_WEB_REQUEST_JSON);
  const args = [
    ".buildchain/runtime/packages/core/web/commands/web-surface.mjs",
    "--mode",
    {
      deploy: "deploy-apply",
      cleanup: "cleanup-apply",
      preflight: "production-preflight",
      health: "health-check",
    }[operation],
    "--cwd",
    input["working-directory"],
  ];
  if (operation === "health")
    return [
      ...args,
      "--result",
      `.buildchain/web-surface-${channel}-apply.json`,
      "--output",
      `.buildchain/web-surface-${channel}-health.json`,
    ];
  const plan = exactWebPlan(
    ".buildchain/downloaded-plans",
    `web-surface-${channel}-plan.json`,
  );
  args.push("--plan", plan);
  if (operation === "preflight")
    return [
      ...args,
      "--execute",
      "true",
      "--output",
      ".buildchain/web-surface-production-preflight.json",
    ];
  return [
    ...args,
    "--dry-run",
    "false",
    "--actor",
    env.GITHUB_ACTOR,
    "--run-id",
    env.GITHUB_RUN_ID,
    "--output",
    `.buildchain/web-surface-${channel}-apply.json`,
  ];
}
export function selectProductionEvidence() {
  const source = exactWebPlan(
    ".buildchain/controller/web-plans",
    "web-surface-production-plan.json",
  );
  fs.copyFileSync(source, ".buildchain/controller/web-surface-plan.json");
}
export async function verifyWebGovernance(env, execute = command) {
  requireValue(
    Boolean(env.BUILDCHAIN_GITHUB_GOVERNANCE_RECEIPT_JSON),
    "Production publication requires a fresh GitHub governance receipt",
  );
  const actual = execute(
    "git",
    ["-C", ".buildchain/runtime", "rev-parse", "HEAD"],
    { stdio: "pipe" },
  )
    .trim()
    .toLowerCase();
  requireValue(
    /^[0-9a-f]{40}$/.test(actual) &&
      actual === String(env.BUILDCHAIN_AUTHORITY_REF || "").toLowerCase(),
    "Governance verifier checkout does not match the exact Buildchain runtime",
  );
  const {
    BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY: authority,
    verifyGithubGovernanceReceipt,
  } = await import(
    pathToFileURL(
      path.resolve(
        ".buildchain/runtime/packages/core/governance/github-governance-authority.js",
      ),
    ).href
  );
  verifyGithubGovernanceReceipt(
    JSON.parse(env.BUILDCHAIN_GITHUB_GOVERNANCE_RECEIPT_JSON),
    {
      expectedOrganization: authority.organization,
      expectedRepository: env.BUILDCHAIN_GITHUB_GOVERNANCE_EXPECTED_REPOSITORY,
      expectedTargetRef: env.BUILDCHAIN_GITHUB_GOVERNANCE_EXPECTED_TARGET_REF,
      expectedPolicyRoot: authority.policyRoot,
      expectedVerifierSourceRevision: actual,
    },
  );
}
