import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveBuildConfiguration } from "../packages/core/build/plan/configuration.js";
import { historicalBuildInputs } from "../packages/core/build/plan/compatibility.js";
import { lifecycleOptions } from "../packages/core/build/plan/lifecycle.js";
import { resolveBuildRunners } from "../packages/core/build/plan/runners.js";
import YAML from "yaml";
import { rootOf } from "../packages/core/build/plan/values.js";
import { qualifyHistoricalBuild } from "../packages/core/build/summary/compatibility.js";
import { historicalEntrySelection } from "../packages/core/runtime/entry/compatibility.js";

function consumer(t, compatibilityInputs, compatibilityEnvironment = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "historical-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(new URL("../fixtures/libnode-shaped", import.meta.url), root, {
    recursive: true,
  });
  const { plan } = resolveBuildConfiguration({
    root,
    compatibilityInputs,
    compatibilityEnvironment,
    workflowRef: "kungfu-systems/buildchain/.github/workflows/build.yml@v4",
    workflowSha: "a".repeat(40),
    repository: "kungfu-systems/buildchain",
    sourceSha: "b".repeat(40),
    sourceRef: "refs/heads/dev/v1/v1.0",
  });
  plan.run = { repository: "example/consumer", id: "10", attempt: "1" };
  return { root, plan };
}

test("legacy build rejects unknown and incorrectly typed parameters", () => {
  for (const value of [
    { "runner-prest": "custom" },
    { "require-build": "true" },
    { "lifecycle-timeout-minutes": Infinity },
    [],
  ])
    assert.throws(() => historicalBuildInputs(value), /historical build/i);
});

test("old kfd-style build preserves its custom matrix, toolchain, command and artifact checks", async (t) => {
  const { root, plan } = consumer(t, {
    "runner-preset": "custom",
    "platforms-json": JSON.stringify([
      {
        id: "x86_64-unknown-linux-gnu",
        name: "Linux x86_64",
        runner: '["ubuntu-24.04"]',
      },
    ]),
    "setup-rust": true,
    "rust-toolchain": "1.95.0",
    "build-command": "npm run build:native-release",
    "require-install": true,
    "require-verify": true,
    "artifact-name": "kfd",
    "artifact-name-template": "{artifact}-{platform}-{shortSha}",
    "artifact-paths": "README.md\ndist/native\n",
    "expected-artifacts-json": '{"minFiles":2,"requiredPaths":["README.md"]}',
    "checkout-history-mode": "full",
  });
  assert.equal(plan.tools.rust, "1.95.0");
  assert.equal(plan.tools.setup_rust, true);
  assert.equal(plan.environment.checkout.history_mode, "full");
  const runners = await resolveBuildRunners(plan, {});
  assert.equal(runners.platforms.length, 1);
  const lifecycle = lifecycleOptions(plan, runners.platforms[0], "build", root);
  assert.equal(lifecycle.command, "npm run build:native-release");
  assert.equal(
    lifecycle.artifactName,
    `kfd-x86_64-unknown-linux-gnu-${"b".repeat(12)}`,
  );
  assert.equal(plan.artifacts.paths, "README.md\ndist/native");
  assert.deepEqual(JSON.parse(plan.artifacts.expected_json), {
    minFiles: 2,
    requiredPaths: ["README.md"],
  });
});

test("legacy defaults leave explicit TOML build choices intact", (t) => {
  const defaults = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/fixtures/consumer-upgrade/build-v4.0.0.json",
        import.meta.url,
      ),
    ),
  );
  const inputs = Object.fromEntries(
    Object.entries(defaults.inputs).map(([key, field]) => [key, field.default]),
  );
  assert.deepEqual(historicalBuildInputs(inputs), {});
  const { plan } = consumer(t, inputs);
  assert.equal(plan.environment.runners.preset, "github-hosted");
});

test("historical required check fails for skipped, failed or tampered builds", () => {
  const body = {
    schema: "buildchain.build-result/v1",
    status: "success",
    plan_root: `sha256:${"a".repeat(64)}`,
  };
  const result = { ...body, root: rootOf(body) };
  assert.deepEqual(
    qualifyHistoricalBuild("success", JSON.stringify(result)),
    result,
  );
  for (const conclusion of ["skipped", "failure", "cancelled", ""])
    assert.throws(
      () => qualifyHistoricalBuild(conclusion, result),
      /did not qualify/,
    );
  assert.throws(
    () =>
      qualifyHistoricalBuild("success", {
        ...result,
        plan_root: `sha256:${"b".repeat(64)}`,
      }),
    /content root/,
  );
});

test("historical build fits the old caller permission envelope and keeps its required check name", () => {
  const allowed = {
    contents: "read",
    actions: "read",
    issues: "write",
    "id-token": "write",
  };
  const ranks = { none: 0, read: 1, write: 2 };
  const read = (name) =>
    YAML.parse(
      fs.readFileSync(
        new URL(`../.github/workflows/${name}`, import.meta.url),
        "utf8",
      ),
    );
  for (const name of ["build.yml", ".build-historical.yml"]) {
    const workflow = read(name);
    assert.equal(
      workflow.permissions,
      undefined,
      "historical envelope is inherited from the caller",
    );
    for (const [id, job] of Object.entries(workflow.jobs))
      for (const [scope, value] of Object.entries(job.permissions || {}))
        assert.ok(
          ranks[value] <= (ranks[allowed[scope]] || 0),
          `${name}/${id} escalates ${scope}`,
        );
  }
  const facade = read("build.yml");
  assert.equal(facade.jobs.summarize.name, "Summarize build contract");
  assert.equal(
    facade.jobs.summarize.steps.find(step => step.uses.endsWith("/qualify-contract")).with.conclusion,
    "${{ needs.build.result }}",
  );
  assert.deepEqual(
    read(".build-historical.yml").jobs.attest.steps.map((step) => step.uses),
    [
      "$/actions/runtime/environment/prepare",
      "./.buildchain/runtime/actions/build/lifecycle/prepare",
      "./.buildchain/runtime/actions/build/artifact/attest",
    ],
    "only maintained runtime actions receive the inherited attestation envelope",
  );
});

test("old selector names retain lock locations and exact runtime overrides", () => {
  const ref = "kungfu-systems/buildchain/.github/workflows/build.yml@v4-alpha";
  const selected = historicalEntrySelection(
    {
      "buildchain-alpha-contract-lock-path":
        "buildchain.alpha-contract-lock.json",
      "buildchain-ref": "v3-alpha",
    },
    ref,
  );
  assert.equal(selected.lockPath, "buildchain.alpha-contract-lock.json");
  assert.equal(selected.runtimeRef, "");
  assert.equal(
    historicalEntrySelection({ "buildchain-ref": "a".repeat(40) }, ref)
      .runtimeRef,
    "a".repeat(40),
  );
  assert.throws(
    () =>
      historicalEntrySelection(
        { "buildchain-repository": "untrusted/runtime" },
        ref,
      ),
    /official Buildchain/,
  );
});

test("old libnode-style transfer retains declared repository variables and explicit overrides", async (t) => {
  const inputs = {
    "runner-preset": "custom",
    "platforms-json": JSON.stringify([
      {
        id: "linux-x64",
        name: "Linux x64",
        runner: '["self-hosted","Linux","X64"]',
      },
    ]),
    "artifact-transfer-mode": "s3-to-github-artifacts",
    "install-command": 'node .gyp/buildchain-install.js "mirror" "reference"',
    "buildchain-stable-contract-lock-path": "buildchain.contract-lock.json",
  };
  const environment = {
    BUILDCHAIN_HISTORICAL_ARTIFACT_RELAY_S3_BUCKET: "fixture-artifacts",
    BUILDCHAIN_HISTORICAL_ARTIFACT_RELAY_S3_REGION: "us-east-1",
    BUILDCHAIN_HISTORICAL_ARTIFACT_RELAY_S3_UPLOAD_ROLE_ARN:
      "arn:aws:iam::123456789012:role/upload",
    BUILDCHAIN_HISTORICAL_ARTIFACT_RELAY_S3_DOWNLOAD_ROLE_ARN:
      "arn:aws:iam::123456789012:role/download",
  };
  const { root, plan } = consumer(t, inputs, environment);
  const resolved = await resolveBuildRunners(plan, {});
  assert.equal(resolved.transfer.mode, "s3-to-github-artifacts");
  assert.equal(resolved.transfer.s3Bucket, "fixture-artifacts");
  assert.equal(plan.contract.lock_path, "buildchain.contract-lock.json");
  assert.equal(
    lifecycleOptions(plan, resolved.platforms[0], "install", root).command,
    inputs["install-command"],
  );
  const explicit = historicalBuildInputs(
    { ...inputs, "artifact-relay-s3-bucket": "explicit" },
    environment,
  );
  assert.equal(explicit["artifact-relay-s3-bucket"], "explicit");
  assert.deepEqual(
    historicalBuildInputs({}, environment),
    {},
    "modern calls never acquire historical repository overrides",
  );
});


test("historical publish eligibility retains ref and pull request restrictions", async (t) => {
  const { historicalPublishGate } = await import("../packages/core/build/plan/compatibility-plan.js");
  const { plan } = consumer(t, {});
  const inputs = { "publish-channel": "alpha" };
  plan.source.ref = "refs/heads/alpha/v1/v1.0";
  historicalPublishGate(plan, inputs, "push");
  assert.equal(plan.historical_publish_gate.allowed, true);
  historicalPublishGate(plan, inputs, "pull_request");
  assert.equal(plan.historical_publish_gate.allowed, false);
  plan.source.ref = "refs/heads/feature/unqualified";
  historicalPublishGate(plan, inputs, "push");
  assert.equal(plan.historical_publish_gate.allowed, false);
  inputs["publish-channel"] = "custom";
  inputs["publish-refs-json"] = '{"custom":["^refs/heads/feature/unqualified$"]}';
  historicalPublishGate(plan, inputs, "workflow_dispatch");
  assert.equal(plan.historical_publish_gate.allowed, true);
  inputs["publish-refs-json"] = '{"custom":["["]}';
  assert.throws(() => historicalPublishGate(plan, inputs, "push"), /invalid/);
});


test("reported lock drift compares the accepted SHA and contract with the selected runtime", async () => {
  const { runtimeContractLockDrift } = await import("../packages/core/contracts/runtime-contract-inspection.js");
  const sha = "a".repeat(40), digest = `sha256:${"b".repeat(64)}`;
  const lock = { buildchain: { resolvedSha: sha, contractDigest: digest } };
  assert.equal(runtimeContractLockDrift(lock, sha, digest), false);
  assert.equal(runtimeContractLockDrift(lock, "c".repeat(40), digest), true);
  assert.equal(runtimeContractLockDrift(lock, sha, `sha256:${"d".repeat(64)}`), true);
  const minimal = { schema: "buildchain.consumer-contract-lock/v2", runtime: { sha } };
  assert.equal(runtimeContractLockDrift(minimal, sha, digest), false);
  assert.equal(runtimeContractLockDrift(minimal, "c".repeat(40), digest), true);
});

test("the retained promotion entry routes its old exact recovery runtime selector", () => {
  const ref = "kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v4";
  const sha = "a".repeat(40);
  assert.equal(historicalEntrySelection({ "resume-buildchain-runtime-sha": sha }, ref).runtimeRef, sha);
  assert.throws(() => historicalEntrySelection({ "resume-buildchain-runtime-sha": "moving" }, ref), /exact runtime SHA/);
  assert.equal(historicalEntrySelection({ "resume-buildchain-runtime-sha": sha }, "kungfu-systems/buildchain/.github/workflows/build.yml@v4").runtimeRef, "");
});
