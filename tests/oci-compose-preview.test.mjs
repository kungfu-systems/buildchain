import assert from "node:assert/strict";
import test from "node:test";
import { verifyComposeQualification } from "../packages/core/publication/oci-compose-qualification.js";
import { promoteComposePreview } from "../packages/core/publication/commands/oci-compose-preview.mjs";
const sha = "a".repeat(40),
  digest = "sha256:" + "b".repeat(64),
  old = "sha256:" + "c".repeat(64);
function fixture() {
  const repository = "example/runtime",
    tag = "v1.0.0-alpha.2";
  const image = {
    repository: "ghcr.io/example/runtime/hub",
    digest: "sha256:" + "d".repeat(64),
    platforms: ["linux/amd64", "linux/arm64"],
  };
  const application = { kind: "compose", repository: image.repository, digest };
  const policy = {
    alias: "compose-preview",
    previousDigest: old,
    qualificationWorkflow: ".github/workflows/qualify.yml",
  };
  const context = {
    repository,
    tag,
    sourceSha: sha,
    application,
    image,
    policy,
    familyRoot: "sha256:" + "e".repeat(64),
    publicationReceiptRoot: "sha256:" + "f".repeat(64),
  };
  const run = {
    id: 123,
    run_attempt: 2,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    path: policy.qualificationWorkflow,
  };
  const receipt = {
    schema: "kungfu-buildchain-compose-qualification/v1",
    repository,
    tag,
    sourceSha: sha,
    familyRoot: context.familyRoot,
    runId: 123,
    runAttempt: 2,
    image: `${image.repository}@${image.digest}`,
    application: `${application.repository}@${digest}`,
    previousDigest: old,
    passed: true,
    checks: Object.fromEntries(
      [
        "freshInstall",
        "restartPersistence",
        "upgradePersistence",
        "rollbackPersistence",
        "accountIsolation",
        "hardenedRuntime",
      ].map((key) => [key, true]),
    ),
    platforms: {
      "linux/amd64": { passed: true },
      "linux/arm64": { passed: true },
    },
    evidence: [{ path: "smoke.json", sha256: old }],
  };
  return { context, run, receipt };
}

test("preview qualification binds exact source, run attempt, both architectures and persistence checks", () => {
  const { context, run, receipt } = fixture();
  assert.doesNotThrow(() => verifyComposeQualification(context, run, receipt));
  for (const changed of [
    { head_sha: "1".repeat(40) },
    { run_attempt: 3 },
    { conclusion: "failure" },
    { event: "pull_request" },
    { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "attacker/runtime" } },
  ])
    assert.throws(() =>
      verifyComposeQualification(context, { ...run, ...changed }, receipt),
    );
  for (const name of Object.keys(receipt.checks)) {
    const bad = structuredClone(receipt);
    bad.checks[name] = false;
    assert.throws(
      () => verifyComposeQualification(context, run, bad),
      /qualification lacks/u,
    );
  }
  for (const changed of [
    { image: "ghcr.io/example/runtime/hub:latest" },
    { previousDigest: "none" },
    { platforms: { "linux/amd64": { passed: true } } },
    { evidence: [{ path: "../secret.json", sha256: old }] },
  ])
    assert.throws(() =>
      verifyComposeQualification(context, run, { ...receipt, ...changed }),
    );
});

test("preview preserves manifest bytes and can recover an uncertain completed write", async () => {
  const { context, receipt } = fixture(),
    bytes = Buffer.from("sealed manifest");
  let current = old,
    writes = 0;
  const fetchManifest = async (ref) => ({
    digest: ref === "compose-preview" ? current : digest,
    bytes,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
  });
  const registry = async (image, target, request) => {
    writes++;
    assert.equal(image.repository, context.application.repository);
    assert.equal(target, "manifests/compose-preview");
    assert.equal(request.method, "PUT");
    assert.deepEqual(request.body, bytes);
    current = digest;
    return { status: 201 };
  };
  const first = await promoteComposePreview({
    context,
    receipt,
    registry,
    fetchManifest,
  });
  const again = await promoteComposePreview({
    context,
    receipt,
    registry,
    fetchManifest,
  });
  assert.equal(writes, 1);
  assert.deepEqual(again, first);
  assert.equal(first.outcome, "complete");
});

test("immutable or expected-old drift prevents every preview write", async () => {
  const { context, receipt } = fixture();
  for (const wrong of ["exact", "old"]) {
    let writes = 0;
    await assert.rejects(
      promoteComposePreview({
        context,
        receipt,
        registry: async () => {
          writes++;
        },
        fetchManifest: async (ref) => ({
          digest:
            (wrong === "exact" && ref !== "compose-preview") ||
            (wrong === "old" && ref === "compose-preview")
              ? "sha256:" + "1".repeat(64)
              : ref === "compose-preview"
                ? old
                : digest,
        }),
      }),
      /digest changed|preview changed/u,
    );
    assert.equal(writes, 0);
  }
});
