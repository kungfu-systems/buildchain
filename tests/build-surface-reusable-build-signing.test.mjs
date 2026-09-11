import { assert, assertOrder, readComposite, readRepoText, test, workflowJob } from "./build-surface-reusable-build-harness.mjs";

test("signing and attestation retain isolated credentials and final-byte checks", () => {
  const sign = workflowJob("sign");
  assert.match(sign, /environment:/u);
  assert.match(sign, /matrix.platform.kind == 'credential' &&\s+secrets.BUILDCHAIN_MACOS_CERTIFICATE/u);
  const action = readComposite("build/artifact/sign");
  assert.match(action, /inputs.kind == 'credential'/u);
  assert.match(action, /inputs.kind == 'artifact'/u);
  assertOrder(action, ["Complete detached signing and finalization", "Validate sealed credential input", "actions/build/credential/macos-island"]);
  assertOrder(readRepoText("packages/core/build/lifecycle/stage.js"), ["runLifecycle({", "await sealSigning", "sealMacosCredentialInput({"]);
  const signing = readRepoText("packages/core/build/signing/transaction.js");
  assertOrder(signing, ["assertArtifactSigningControllerReceipt({", "await downloadBuild(platform, sourceRoot)", "importArtifactSigningResults({", "plan.build.finalization.command)", "verifyManifest(manifest"]);
  const attest = workflowJob("attest");
  assert.match(attest, /runs-on: ubuntu-24.04/u);
  assert.match(attest, /attestations: write/u);
  assert.doesNotMatch(attest, /checkout-source:|run-build-stage/u);
  assert.match(readRepoText("packages/core/build/artifact/attestation.js"), /--deny-self-hosted-runners/u);
});

test("infrastructure configuration has one governed authority", () => {
  const config = readRepoText("packages/core/build/build-configuration.js");
  const registry = JSON.parse(readRepoText("architecture/build-environments.json"));
  assert.ok(registry.defaults.runners && registry.defaults.transfer && registry.defaults.cache);
  assert.doesNotMatch(config, /upload_role_arn|download_role_arn|kfd_agent_hub/u);
  assert.ok(!Object.hasOwn(registry.defaults.tools, "kfd_agent_hub"));
  assert.match(readRepoText("packages/core/build/lifecycle/stage.js"), /SHIFU_CACHE_PROFILE_DIGEST/u);
  assert.match(readRepoText("packages/core/build/environment/provision.js"), /fetchAttempts: checkout.fetch_attempts/u);
});
