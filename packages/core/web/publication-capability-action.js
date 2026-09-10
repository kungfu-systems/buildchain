import fs from "node:fs";
import path from "node:path";
import { exactWebPlan } from "./deployment/plan-files.js";
import { verifyWebPublicationCapability } from "./publication-capability.js";

export function webPublicationCapabilityAction(core, env) {
  const required = (name) => core.getInput(name, { required: true });
  const planPath = exactWebPlan(
    path.join(env.GITHUB_WORKSPACE, ".buildchain/downloaded-plans"),
    "web-surface-production-plan.json",
  );
  verifyWebPublicationCapability({
    capability: JSON.parse(required("capability-json")),
    candidate: JSON.parse(required("candidate-json")),
    plan: JSON.parse(fs.readFileSync(planPath, "utf8")),
    repository: env.GITHUB_REPOSITORY,
    sourceSha: required("source-sha"),
    runtimeSha: required("runtime-sha"),
    environment: required("environment"),
    roleArn: required("role-arn"),
  });
}
