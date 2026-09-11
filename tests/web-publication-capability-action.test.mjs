import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  publicationAuthorityDigest,
  PUBLICATION_CAPABILITY_CONTRACT,
} from "../packages/core/publication/publication-authority.js";
import { webSurfacePublicationDigest } from "../packages/core/web/web-surface-publication-candidate.js";
import { verifyWebPublicationCapability } from "../packages/core/web/publication-capability.js";
function fixture() {
  const request = {
    repository: "test/site",
    sourceSha: "a".repeat(40),
    runtimeSha: "b".repeat(40),
    environment: "production",
    roleArn: "arn:aws:iam::123456789012:role/publish",
  };
  const plan = {
    artifact: { hash: "artifact" },
    manifest: { site: "site", deployTarget: "target" },
  };
  const candidatePayload = {
    repository: request.repository,
    sourceSha: request.sourceSha,
    runtimeSha: request.runtimeSha,
    environment: request.environment,
    site: "site",
    planDigest: crypto
      .createHash("sha256")
      .update(JSON.stringify(plan, null, 2) + "\n")
      .digest("hex"),
    artifactHash: "artifact",
    deployTarget: "target",
  };
  const candidate = {
    ...candidatePayload,
    candidateDigest: webSurfacePublicationDigest(candidatePayload),
  };
  const payload = {
    contract: PUBLICATION_CAPABILITY_CONTRACT,
    decision: "allow",
    expiresAt: "2099-01-01T00:00:00Z",
    artifactDigest: candidate.candidateDigest,
    workflowPath: ".github/workflows/public-release-web.yml",
    repository: request.repository,
    sourceSha: request.sourceSha,
    runtimeSha: request.runtimeSha,
    environment: request.environment,
    product: "site",
    target: `aws-role:${request.roleArn}#deploy:target`,
    version: request.sourceSha,
    channel: "production",
    capabilityIds: ["web-production"],
  };
  return {
    ...request,
    plan,
    candidate,
    capability: {
      ...payload,
      capabilityDigest: publicationAuthorityDigest(payload),
    },
  };
}
test("Web admission binds the sealed capability to every source, runtime, environment and plan coordinate", () => {
  const request = fixture();
  assert.equal(verifyWebPublicationCapability(request).ok, true);
  for (const field of ["sourceSha", "runtimeSha", "environment", "roleArn"])
    assert.throws(
      () =>
        verifyWebPublicationCapability({ ...request, [field]: "substitution" }),
      /binding mismatch/,
    );
  assert.throws(
    () =>
      verifyWebPublicationCapability({
        ...request,
        plan: { ...request.plan, artifact: { hash: "changed" } },
      }),
    /plan binding mismatch/,
  );
});
test("Web admission reuses publication authority validation and rejects malformed expiry even with a matching digest", () => {
  const request = fixture();
  const { capabilityDigest, ...payload } = request.capability;
  for (const expiresAt of ["not-a-time", "2000-01-01T00:00:00Z"]) {
    const changed = { ...payload, expiresAt };
    assert.throws(
      () =>
        verifyWebPublicationCapability({
          ...request,
          capability: {
            ...changed,
            capabilityDigest: publicationAuthorityDigest(changed),
          },
        }),
      /expiresAt|stale/,
    );
  }
});
