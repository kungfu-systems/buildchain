import fs from "node:fs";
import { admitWebApplyInputs } from "./apply-admission.js";

export function webApplyAdmissionAction(core, env) {
  const payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const decisionApproved = core.getInput("decision-approved")
    ? core.getBooleanInput("decision-approved")
    : false;
  const values = admitWebApplyInputs({
    request: JSON.parse(core.getInput("request-json", { required: true })),
    decisionApproved,
    event: {
      name: env.GITHUB_EVENT_NAME,
      action: payload.action,
      refName: env.GITHUB_REF_NAME,
      pullNumber: payload.pull_request?.number,
    },
  });
  for (const [key, value] of Object.entries(values)) core.setOutput(key, value);
}
