import { requireValue } from "../../runtime/action-process.mjs";
export function lineProtection(plan, channel) {
  requireValue(
    ["dev", "alpha", "release"].includes(channel),
    "Unknown release line channel",
  );
  const policy = plan.protection;
  return {
    required_status_checks: {
      strict: policy.strictStatusChecksByChannel[channel],
      checks: [
        ...new Set([
          policy.requiredStatusCheck,
          ...(channel === "alpha" ? ["verify"] : []),
        ]),
      ]
        .sort()
        .map((context) => ({ context, app_id: 15368 })),
    },
    enforce_admins: policy.enforceAdmins,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      required_approving_review_count: policy.requiredApprovingReviewCount,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
      bypass_pull_request_allowances: {
        apps: ["github-actions"],
        users: [],
        teams: [],
      },
    },
    restrictions: null,
    required_conversation_resolution: policy.requiredConversationResolution,
  };
}
