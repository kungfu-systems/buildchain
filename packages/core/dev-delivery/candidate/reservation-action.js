import { deliveryActionContext } from "../native/action-context.js";
import { reserveDeliveryCandidate } from "./reservation.js";
export async function reserveDeliveryCandidateAction(core, env) {
  const context = deliveryActionContext(core, env);
  const result = await reserveDeliveryCandidate({
    ...context,
    input: JSON.parse(core.getInput("request-json", { required: true })),
    connection: {
      repository: env.GITHUB_REPOSITORY,
      token: core.getInput("token", { required: true }),
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    },
    branch: core.getInput("branch", { required: true }),
    sourceProofRoot: core.getInput("source-proof-root"),
    qualificationOutcome: core.getInput("qualification-outcome"),
    proofOutcome: core.getInput("proof-outcome"),
    predecessorsOk: core.getBooleanInput("predecessors-ok"),
  });
  for (const [name, value] of Object.entries(result))
    core.setOutput(name, value);
}
