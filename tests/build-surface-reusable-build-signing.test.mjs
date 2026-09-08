import { assert, assertOrder, readComposite, readRepoText, test, workflowJob } from "./build-surface-reusable-build-harness.mjs";

test("signing requests stay between build and verify while authority and final-byte verification remain separate", () => {
  for (const job of ["build-native", "build-linux-container"]) {
    const source = workflowJob(job);
    assertOrder(source, ["Run install lifecycle", "Prepare auditable compiler cache", "Run build lifecycle", "Verify auditable compiler cache activity", "build-signing-request", "Run verify lifecycle"]);
    assert.doesNotMatch(source, /Dispatch and await exact Buildchain signing authority|certificate-p12-base64|apple-api-private-key/u);
  }
  const signing = readComposite("build-signing-request");
  assertOrder(signing, ["Seal declared artifact signing requests", "Resolve artifact signing request upload route", "Publish Buildchain-owned artifact signing request", "Seal detached signing control request", "Publish detached signing control request"]);
  assert.match(signing, /seal-artifact-signing-requests\.mjs/u);
  assert.doesNotMatch(signing, /legacy runtime|request-count=0/u);
  assert.match(signing, /BUILDCHAIN_SOURCE_TREE_SHA:/u);
  assert.match(signing, /NO_PROXY:/u);
  const finalization = workflowJob("finalize-artifact-signing");
  assertOrder(finalization, ["Download pre-signing deterministic artifact", "Verify and import final signed bytes", "Verify final artifact bytes with consumer policy", "Recompute manifest over final signed bytes"]);
  assert.match(finalization, /BUILDCHAIN_ARTIFACT_SIGNING_STATE:/u);
  assert.match(finalization, /needs\.artifact-signing-control\.outputs\.source-run-attempt/u);
  const island = workflowJob("credential-island-macos");
  assert.match(island, /environment:\n\s+name:/u);
  assert.match(island, /sourceTreeSha: process\.env\.BUILDCHAIN_SOURCE_TREE_SHA/u);
  assert.match(island, /expected-bundle-id: \$\{\{ steps\.credential-identity\.outputs\.bundle-id \}\}/u);
  const policy = readComposite("build-attestation-policy");
  for (const field of ["BUILDCHAIN_SOURCE_SHA", "BUILDCHAIN_SOURCE_TREE_SHA", "BUILDCHAIN_RUNTIME_SHA", "BUILDCHAIN_GITHUB_ATTESTATION_SIGNER_SHA"]) assert.ok(policy.includes(field), field);
});

test("cache and runner infrastructure have one governed environment authority", () => {
  const environment = JSON.parse(readRepoText("architecture/build-environments.json"));
  assert.equal(environment.defaults.checkout.mode, "off");
  assert.equal(environment.defaults.checkout.fallback, "github");
  assert.equal(environment.defaults.cache.provider, "none");
  const lifecycle = readComposite("build-lifecycle-stage");
  for (const field of ["BUILDCHAIN_DEPENDENCY_LOCK_ROOT", "BUILDCHAIN_TOOLCHAIN_ROOT", "BUILDCHAIN_CACHE_POLICY_ROOT", "SHIFU_CACHE_PROFILE_REF", "SHIFU_CACHE_PROFILE_DIGEST"]) assert.ok(lifecycle.includes(field), field);
  for (const job of ["build-native", "build-linux-container"]) {
    const source = workflowJob(job);
    for (const field of ["BUILDCHAIN_CHECKOUT_CACHE_FETCH_ATTEMPTS", "BUILDCHAIN_CHECKOUT_CACHE_GITHUB_TIMEOUT_SECONDS", "BUILDCHAIN_CHECKOUT_HISTORY_MODE"]) assert.ok(source.includes(field), field);
  }
});
