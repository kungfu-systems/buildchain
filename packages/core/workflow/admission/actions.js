import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import {
  inspectUniversalRequest,
  admitConsumerCapability,
} from "./transactions.js";
const request = (core) =>
  JSON.parse(core.getInput("request-json", { required: true }));
export function inspectUniversalRequestAction(core) {
  const outputs = inspectUniversalRequest(
    request(core),
  );
  for (const [key, value] of Object.entries(outputs))
    core.setOutput(key, value);
}
export function admitConsumerCapabilityAction(core, env) {
  const admitted = admitConsumerCapability({
    request: request(core),
    runtime: JSON.parse(env.BUILDCHAIN_RUNTIME_SELECTION),
    workspace: env.GITHUB_WORKSPACE,
    runtimeRoot: installationRoot(import.meta.url),
    consumer: {
      repository: env.GITHUB_REPOSITORY,
      sha: env.GITHUB_SHA,
      workflowRef: env.GITHUB_WORKFLOW_REF,
    },
  });
  for (const [key, value] of Object.entries({
    "runtime-sha": admitted.runtime.sha,
    "request-root": admitted.requestRoot,
    "admission-root": admitted.admissionRoot,
    "admission-json": JSON.stringify(admitted),
  }))
    core.setOutput(key, value);
}
