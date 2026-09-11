export function admitWebApplyInputs({
  request = {},
  event,
  decisionApproved = false,
}) {
  if (typeof decisionApproved !== "boolean")
    throw new Error("Production decision must be boolean");
  for (const key of [
    "preview-apply",
    "preview-cleanup-apply",
    "staging-apply",
    "production-apply",
  ])
    if (request[key] !== undefined && typeof request[key] !== "boolean")
      throw new Error(`${key} must be boolean`);
  const pull = event.name === "pull_request",
    closed = event.action === "closed";
  const main = event.name === "push" && event.refName === "main";
  const required = [
    [pull && !closed && request["preview-apply"], "preview"],
    [
      pull && closed && !decisionApproved && request["preview-cleanup-apply"],
      "preview",
    ],
    [main && request["staging-apply"], "staging"],
    [decisionApproved && request["production-apply"], "production"],
  ];
  for (const [applies, channel] of required)
    if (applies && !request[`${channel}-aws-role-arn`])
      throw new Error(
        `${channel}-aws-role-arn is required before build or deployment`,
      );
  let channel = "",
    alias = "";
  if (decisionApproved) channel = "production";
  else if (pull && !closed) {
    if (!Number.isSafeInteger(event.pullNumber) || event.pullNumber < 1)
      throw new Error("Preview requires an exact pull request number");
    channel = "preview";
    alias = `pr-${event.pullNumber}`;
  } else if (!pull && (main || event.name === "workflow_dispatch"))
    channel = "staging";
  return { "web-surface-channel": channel, "web-surface-alias": alias };
}
