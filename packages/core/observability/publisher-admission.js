import fs from "node:fs";
import { requireValue } from "../runtime/action-process.mjs";

export function admitEvidencePublisher({ eventName, ref, defaultBranch }) {
  requireValue(
    ["schedule", "workflow_dispatch"].includes(eventName),
    "Observed evidence publication only admits schedule or workflow_dispatch callers",
  );
  requireValue(
    typeof defaultBranch === "string" && defaultBranch.length > 0,
    "Evidence publisher requires the caller default branch",
  );
  requireValue(
    ref === `refs/heads/${defaultBranch}`,
    "Observed evidence publication requires the caller default branch",
  );
}

export function evidencePublisherAdmissionAction(_core, env) {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  admitEvidencePublisher({
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    defaultBranch: event.repository?.default_branch,
  });
}
