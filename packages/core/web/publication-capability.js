import crypto from "node:crypto";
import { validatePublicationCapability } from "../publication/publication-authority.js";
import { webSurfacePublicationDigest } from "./web-surface-publication-candidate.js";

function required(request, name) {
  const value = String(request[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function verifyWebPublicationCapability(request, now = Date.now()) {
  const { capability, candidate, plan } = request;
  const capabilityDigest = validatePublicationCapability(
    capability,
    new Date(now),
  );
  const { candidateDigest, ...candidatePayload } = candidate;
  if (
    webSurfacePublicationDigest(candidatePayload) !== candidateDigest ||
    candidateDigest !== capability.artifactDigest
  ) {
    throw new Error(
      "web-surface publication candidate capability binding mismatch",
    );
  }
  const planDigest = crypto
    .createHash("sha256")
    .update(`${JSON.stringify(plan, null, 2)}\n`)
    .digest("hex");
  if (
    candidate.planDigest !== planDigest ||
    candidate.artifactHash !== plan.artifact?.hash ||
    candidate.deployTarget !== plan.manifest?.deployTarget
  ) {
    throw new Error("web-surface publication candidate plan binding mismatch");
  }
  const roleArn = required(request, "roleArn");
  const exact = {
    workflowPath: ".github/workflows/public-release-web.yml",
    repository: required(request, "repository"),
    sourceSha: required(request, "sourceSha").toLowerCase(),
    runtimeSha: required(request, "runtimeSha").toLowerCase(),
    environment: required(request, "environment"),
    product: String(plan.manifest?.site || ""),
    target: `aws-role:${roleArn}#deploy:${String(plan.manifest?.deployTarget || "")}`,
    version: required(request, "sourceSha").toLowerCase(),
    channel: "production",
  };
  for (const [name, value] of Object.entries(exact)) {
    if (capability[name] !== value)
      throw new Error(
        `web-surface publication capability ${name} binding mismatch`,
      );
  }
  for (const [name, value] of Object.entries({
    repository: exact.repository,
    sourceSha: exact.sourceSha,
    runtimeSha: exact.runtimeSha,
    site: exact.product,
    environment: exact.environment,
  })) {
    if (candidate[name] !== value)
      throw new Error(
        `web-surface publication candidate ${name} binding mismatch`,
      );
  }
  if (capability.capabilityIds?.includes("web-production") !== true) {
    throw new Error(
      "web-surface publication capability lacks web-production authority",
    );
  }
  return { ok: true, capabilityDigest };
}
