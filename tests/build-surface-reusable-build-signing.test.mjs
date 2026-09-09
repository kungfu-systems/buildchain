import { assert, assertOrder, readComposite, readRepoText, test, workflowJob } from "./build-surface-reusable-build-harness.mjs";

test("signing and attestation retain isolated credentials and final-byte checks", () => {
  const sign = workflowJob("sign");
  assert.match(sign, /environment:/u);
  assert.match(sign, /matrix.platform.kind == 'credential' && secrets.BUILDCHAIN_MACOS_CERTIFICATE/u);
  const action = readComposite("sign-build-artifact");
  assert.match(action, /inputs.kind == 'credential'/u);
  assert.match(action, /inputs.kind == 'artifact'/u);
  assertOrder(action, ["Resolve detached signing authority", "Verify and finalize artifact bytes", "Validate sealed credential input", "macos-credential-island"]);
  assertOrder(readRepoText("scripts/build/stage.mjs"), ["runLifecycle(lifecycleOptions", "await sealSigning", "seal-macos-credential-input.mjs"]);
  const signing = readRepoText("scripts/build/sign.mjs");
  assertOrder(signing, ["assertArtifactSigningControllerReceipt({", "await downloadBuild(plan, platform, sourceRoot)", "importArtifactSigningResults({", "plan.build.finalization.command)", "verifyManifest(manifest"]);
  const attest = workflowJob("attest");
  assert.match(attest, /runs-on: ubuntu-24.04/u);
  assert.match(attest, /attestations: write/u);
  assert.doesNotMatch(attest, /checkout-source:|run-build-stage/u);
  assert.match(readRepoText("scripts/build/attest.mjs"), /--deny-self-hosted-runners/u);
});

test("infrastructure configuration has one governed authority", () => {
  const config = readRepoText("packages/core/build-configuration.js");
  const registry = JSON.parse(readRepoText("architecture/build-environments.json"));
  assert.ok(registry.defaults.runners && registry.defaults.transfer && registry.defaults.cache);
  assert.doesNotMatch(config, /upload_role_arn|download_role_arn|kfd_agent_hub/u);
  assert.ok(!Object.hasOwn(registry.defaults.tools, "kfd_agent_hub"));
  assert.match(readRepoText("scripts/build/stage.mjs"), /SHIFU_CACHE_PROFILE_DIGEST/u);
  assert.match(readRepoText("scripts/build/prepare.mjs"), /BUILDCHAIN_CHECKOUT_CACHE_FETCH_ATTEMPTS/u);
});
