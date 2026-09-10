import {
  qualifyObservedEvidence,
  publishQualifiedEvidence,
} from "./transactions.js";

export async function qualifyObservedEvidenceAction(core, env) {
  await qualifyObservedEvidence({
    request: JSON.parse(core.getInput("request-json", { required: true })),
    workspace: env.GITHUB_WORKSPACE,
    environment: env,
    token: core.getInput("token", { required: true }),
  });
}
export function publishObservedEvidenceAction(core, env) {
  const { receiptPath } = publishQualifiedEvidence({
    request: JSON.parse(core.getInput("request-json", { required: true })),
    workspace: env.GITHUB_WORKSPACE,
  });
  core.setOutput("receipt-path", receiptPath);
}
