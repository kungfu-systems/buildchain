import fs from "node:fs";
import { installationRoot } from "../../runtime/installation-root.js";
import {
  initializeSourceQualification,
  finalizeSourceQualification,
} from "./controller.js";
const json = (core, name) =>
  JSON.parse(core.getInput(name, { required: true }));
export function initializeSourceQualificationAction(core, env) {
  const { identities, plan } = initializeSourceQualification({
    workspace: env.GITHUB_WORKSPACE,
    runtimeRoot: installationRoot(import.meta.url),
    runtimeRef: core.getInput("runtime-ref", { required: true }),
    repository: env.GITHUB_REPOSITORY,
    request: json(core, "request-json"),
  });
  for (const [key, value] of Object.entries({
    ...identities,
    "controller-plan-json": JSON.stringify(plan),
    "controller-plan-digest": plan.digest,
  }))
    core.setOutput(key, value);
}
export function finalizeSourceQualificationAction(core, env) {
  const { proof } = finalizeSourceQualification(
    {
      workspace: env.GITHUB_WORKSPACE,
      observations: json(core, "observations-json"),
      request: json(core, "request-json"),
      sourceOutcome: core.getInput("source-outcome", { required: true }),
      identities: json(core, "identities-json"),
      runtimeRef: core.getInput("runtime-ref", { required: true }),
      repository: env.GITHUB_REPOSITORY,
      eventName: env.GITHUB_EVENT_NAME,
      event: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
      runId: env.GITHUB_RUN_ID,
      qualifiedAt: new Date().toISOString(),
    },
    {
      observe(receipt) {
        for (const [key, value] of Object.entries({
          "controller-receipt-json": JSON.stringify(receipt),
          "controller-receipt-digest": receipt.digest,
          "controller-receipt-status": receipt.status,
          "controller-receipt-qualifying": String(receipt.qualifying),
        }))
          core.setOutput(key, value);
      },
    },
  );
  if (proof) core.setOutput("proof-root", proof.proofRoot);
}
