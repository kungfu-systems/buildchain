import { selectedDeliveryActionContext } from "../native/action-context.js";
import { admitDeliveryRequest, qualifyDeliverySource } from "./admission.js";
export function admitDeliveryRequestAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const result = admitDeliveryRequest(request, env.GITHUB_REF_NAME);
  for (const [name, value] of Object.entries(result))
    core.setOutput(name, value);
}
export async function qualifyDeliverySourceAction(core, env) {
  const context = selectedDeliveryActionContext(core, env);
  const result = await qualifyDeliverySource(
    {
      ...context,
      request: JSON.parse(core.getInput("request-json", { required: true })),
      repository: env.GITHUB_REPOSITORY,
      branch: core.getInput("branch", { required: true }),
      token: core.getInput("token", { required: true }),
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
      environment: env,
    },
    {
      onEvidence: (values) => {
        for (const [name, value] of Object.entries(values))
          core.setOutput(name, value);
      },
      onQualification: (result) => {
        if (env.GITHUB_STEP_SUMMARY) core.summary.addRaw(result.summary);
      },
    },
  );
  for (const [name, value] of Object.entries(result))
    core.setOutput(name, value);
  if (env.GITHUB_STEP_SUMMARY) await core.summary.write();
}
