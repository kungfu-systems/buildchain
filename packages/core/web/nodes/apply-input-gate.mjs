import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { requireValue } from "../../runtime/action-process.mjs";

export function webApplyInputGate(env) {
  const pr = env.EVENT_NAME === "pull_request";
  const closed = env.EVENT_ACTION === "closed";
  const main = env.EVENT_NAME === "push" && env.REF_NAME === "main";
  const approved = env.PRODUCTION_DECISION_APPROVED === "true";
  const required = [
    [
      pr && !closed && env.PREVIEW_APPLY === "true",
      env.PREVIEW_ROLE_ARN,
      "preview-aws-role-arn is required before preview-apply can build or deploy",
    ],
    [
      pr && closed && !approved && env.PREVIEW_CLEANUP_APPLY === "true",
      env.PREVIEW_ROLE_ARN,
      "preview-aws-role-arn is required before preview-cleanup-apply can run",
    ],
    [
      main && env.STAGING_APPLY === "true",
      env.STAGING_ROLE_ARN,
      "staging-aws-role-arn is required before staging-apply can build or deploy",
    ],
    [
      approved && env.PRODUCTION_APPLY === "true",
      env.PRODUCTION_ROLE_ARN,
      "production-aws-role-arn is required before production-apply can build or deploy",
    ],
  ];
  for (const [applies, role, message] of required)
    requireValue(!applies || Boolean(role), message);
  let channel = "",
    alias = "";
  if (approved) channel = "production";
  else if (pr && !closed) {
    requireValue(
      /^[1-9]\d*$/.test(env.PULL_REQUEST_NUMBER || ""),
      "Preview requires an exact pull request number",
    );
    channel = "preview";
    alias = `pr-${env.PULL_REQUEST_NUMBER}`;
  } else if (!pr && (main || env.EVENT_NAME === "workflow_dispatch"))
    channel = "staging";
  return { "web-surface-channel": channel, "web-surface-alias": alias };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const outputs = webApplyInputGate(process.env);
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  } catch (error) {
    console.error(`buildchain: ${error.message}`);
    process.exitCode = 1;
  }
}
