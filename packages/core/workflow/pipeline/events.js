import { admitEvent } from "../../consumer/contract/entries.js";

const SHA = /^[0-9a-f]{40}$/u;
function prNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Pipeline event requires an exact PR number");
  return value;
}

// Webhook payloads select readback work only. They never carry source, approval,
// Warrant or mutation authority. Live provider state owns every decision.
export function pipelineEvent(name, event, repository) {
  admitEvent(name, event.action || "");
  if (event.repository?.full_name !== repository)
    throw new Error("Pipeline event repository mismatch");
  if (
    ["pull_request", "pull_request_target", "pull_request_review"].includes(
      name,
    )
  )
    return {
      kind: "pull-request",
      pullRequest: prNumber(event.pull_request?.number),
      terminalOnly: name === "pull_request_target",
    };
  if (name === "repository_dispatch") {
    const payload = event.client_payload;
    if (
      !payload ||
      Object.keys(payload).length !== 1 ||
      !/^attempt-[0-9a-f]{64}$/u.test(payload.attempt || "")
    )
      throw new Error("Attempt wake requires only its exact business selector");
    return { kind: "attempt", attempt: payload.attempt, terminalOnly: false };
  }
  if (name === "merge_group") {
    const group = event.merge_group;
    if (
      !SHA.test(group?.head_sha || "") ||
      !SHA.test(group?.base_sha || "") ||
      !group.base_ref?.startsWith("refs/heads/")
    )
      throw new Error("Merge group requires exact provider coordinates");
    return {
      kind: "merge-group",
      commit: group.head_sha,
      baseCommit: group.base_sha,
      branch: group.base_ref.slice(11),
      terminalOnly: false,
    };
  }
  if (!event.ref?.startsWith("refs/heads/") || event.deleted === true)
    return { kind: "ignore", reason: "not-a-live-branch" };
  if (!SHA.test(event.after || ""))
    throw new Error("Branch event requires an exact commit");
  // Internal journal and lock writes must not recursively wake the pipeline.
  const branch = event.ref.slice(11);
  return /^(?:dev|alpha|release|publish-gate)\//u.test(branch)
    ? { kind: "branch", branch, commit: event.after, terminalOnly: false }
    : { kind: "ignore", reason: "not-a-channel-branch" };
}

function matches(pattern, branch) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(branch);
}

export function channelRoute(plan, pullRequest, repository) {
  if (
    pullRequest.base?.repo?.full_name !== repository ||
    pullRequest.head?.repo?.full_name !== repository
  )
    throw new Error("Pipeline delivery requires a repository-owned channel PR");
  const routes = plan.channels.filter(
    (channel) =>
      channel.to === pullRequest.base.ref &&
      matches(channel.from, pullRequest.head.ref),
  );
  if (routes.length > 1) throw new Error("Ambiguous protected channel route");
  return routes[0] || null;
}
