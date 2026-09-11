import { scanRuntimeSelectorPersistence } from "../packages/core/consumer/runtime-selector-persistence.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  createRuntimeResumeLineage,
  runtimeResumeDocumentRoot,
  verifyRuntimeResumeLineage,
} from "../packages/core/release/recovery/lineage.js";
import { finalizeRuntimeResumeEvidence } from "../packages/core/release/recovery/runtime.js";
import { collectGitHubReleasePassport } from "../packages/core/release/passport/collection.js";
import { createReleasePassport } from "../packages/core/release/passport/assembly.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SOURCE_SHA = "c".repeat(40);
const TREE_SHA = "d".repeat(40);
const ROOT_A = `sha256:${"a".repeat(64)}`;
const ROOT_B = `sha256:${"b".repeat(64)}`;
const ROOT_C = `sha256:${"c".repeat(64)}`;
const ROOT_D = `sha256:${"d".repeat(64)}`;
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const evidenceSchema = JSON.parse(
  fs.readFileSync(
    path.join(
      repositoryRoot,
      "contracts/runtime-resume-lineage-v2.schema.json",
    ),
    "utf8",
  ),
);
const scenario = JSON.parse(
  fs.readFileSync(
    path.join(
      repositoryRoot,
      "contracts/fixtures/runtime-resume-lineage-v2/scenario.json",
    ),
    "utf8",
  ),
);

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function cleanConsumer() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-runtime-authority-"),
  );
  write(
    path.join(root, ".github/workflows/release.yml"),
    `on:\n  workflow_dispatch:\n    inputs:\n      buildchain-ref:\n        default: ""\npermissions:\n  id-token: write\njobs:\n  release:\n    uses: kungfu-systems/buildchain/.github/workflows/public-release-promote.yml@v4-alpha\n    with:\n      buildchain-ref: \${{ inputs.buildchain-ref }}\n`,
  );
  write(
    path.join(root, ".buildchain/contract-lock.json"),
    `${JSON.stringify({ resolvedSha: SHA_A })}\n`,
  );
  write(
    path.join(root, ".buildchain/alpha-contract-lock.json"),
    `${JSON.stringify({ resolvedSha: SHA_B })}\n`,
  );
  return root;
}

function capsule(platform) {
  return {
    platform,
    capsuleRoot: ROOT_A,
    identityRoot: ROOT_B,
    artifactDigest: ROOT_D,
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    policyRoot: ROOT_C,
    buildRuntimeSha: SHA_A,
    sealed: true,
  };
}

for (const channel of ["alpha", "stable"])
  test(`resume finalization reads ${channel} public effects before producing Passport lineage`, async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-runtime-finalize-"),
    );
    try {
      const version = channel === "alpha" ? "4.0.1-alpha.6" : "4.0.1",
        targetRef = `${channel === "alpha" ? "alpha" : "release"}/v4/v4.0`,
        integrity = "sha512-public";
      const body = {
        schemaVersion: 1,
        contract: "kungfu-buildchain-v4-runtime-resume-material/v1",
        repository: "kungfu-systems/consumer",
        targetRef,
        runtimeSha: SHA_B,
        version,

        buildAttempt: { id: "attempt-build-17", runtimeSha: SHA_A },
        resumeAttempt: { id: "attempt-resume-18", runtimeSha: SHA_B },
        source: { sha: SOURCE_SHA, treeSha: TREE_SHA },
        consumerPolicyReceiptRoot: ROOT_C,
        requiredPlatforms: ["linux-x64"],
        stageCapsules: [capsule("linux-x64")],
        resumePlanRoot: ROOT_A,
      };
      const materialPath = path.join(root, "material.json");
      fs.writeFileSync(
        materialPath,
        JSON.stringify({ ...body, root: runtimeResumeDocumentRoot(body) }),
      );
      const fetchImpl = async (url) => {
        const value = String(url).includes("registry.npmjs.org")
          ? {
              "dist-tags": {
                [channel === "alpha" ? "alpha" : "latest"]: version,
              },
              versions: { [version]: { dist: { integrity } } },
            }
          : String(url).includes("/contents/package.json")
            ? {
                type: "file",
                encoding: "base64",
                content: Buffer.from(JSON.stringify({ version })).toString(
                  "base64",
                ),
              }
            : String(url).includes("/compare/")
              ? { status: "ahead" }
              : {
                  object: {
                    sha: String(url).endsWith(
                      channel === "alpha" ? "tags/v4-alpha" : "tags/v4",
                    )
                      ? SHA_B
                      : String(url).endsWith(`tags/v${version}`)
                        ? SOURCE_SHA
                        : "e".repeat(40),
                  },
                };
        return {
          ok: true,
          status: 200,
          json: async () => value,
          text: async () => JSON.stringify(value),
        };
      };
      await assert.rejects(
        finalizeRuntimeResumeEvidence({
          materialPath,
          transaction: { target_ref: targetRef, version, state: "published" },
          outputDir: root,
        }),
        /completed publication transaction/,
      );
      const result = await finalizeRuntimeResumeEvidence({
        materialPath,
        transaction: {
          target_ref: targetRef,
          source_sha: SOURCE_SHA,
          exact_tag: `v${version}`,
          version,
          state: "complete",
          artifacts: [
            {
              kind: "npm",
              required: true,
              name: "@kungfu-tech/buildchain",
              ref: version,
              digest: integrity,
            },
          ],
        },
        token: "test",
        fetchImpl,
        outputDir: root,
      });
      assert.equal(
        result.evidence.lineage.finalPublicReadbackRoot,
        result.readback.root,
      );
      assert.equal(result.evidence.lineage.attempts.resume.runtimeSha, SHA_B);
      assert.ok(fs.existsSync(result.path));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test("source scan records OIDC and rejects selectors persisted outside uses nodes", () => {
  const root = cleanConsumer();
  const clean = scanRuntimeSelectorPersistence({ root });
  assert.equal(clean.status, "passed");
  assert.deepEqual(clean.failures, []);
  assert.ok(clean.authorityUsage.some((entry) => entry.class === "oidc"));
  assert.equal(
    clean.root,
    runtimeResumeDocumentRoot((({ root: _root, ...value }) => value)(clean)),
  );

  write(
    path.join(root, ".buildchain/release-runtime.toml"),
    `buildchain_runtime_sha = "${SHA_B}"\n`,
  );
  write(
    path.join(root, ".buildchain/runtime.json"),
    `${JSON.stringify({ buildchainRuntime: { sha: SHA_B } }, null, 2)}\n`,
  );
  write(
    path.join(root, ".github/actions/runtime/action.yml"),
    "name: runtime\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      env:\n        BUILDCHAIN_RUNTIME_SHA: ${{ vars.BUILDCHAIN_RUNTIME_SHA }}\n      run: echo runtime\n",
  );
  const rejected = scanRuntimeSelectorPersistence({ root });
  assert.equal(rejected.status, "rejected");
  assert.ok(
    rejected.failures.some(
      (failure) => failure.code === "persistent-runtime-exact-sha",
    ),
  );
  assert.ok(
    rejected.failures.some(
      (failure) => failure.code === "persistent-runtime-external-indirection",
    ),
  );
  assert.ok(
    rejected.failures.some(
      (failure) => failure.code === "persistent-runtime-json-value",
    ),
  );
});

test("new attempt reuses sealed capsules with a selected repair runtime and rebuilds only the missing platform", () => {
  const result = createRuntimeResumeLineage({
    repository: "kungfu-systems/consumer",

    buildAttempt: { id: "attempt-build-17", runtimeSha: SHA_A },
    resumeAttempt: { id: "attempt-resume-18", runtimeSha: SHA_B },
    source: { sha: SOURCE_SHA, treeSha: TREE_SHA },
    consumerPolicyReceiptRoot: ROOT_C,
    requiredPlatforms: ["linux-x64", "macos-arm64", "windows-x64"],
    stageCapsules: [capsule("linux-x64"), capsule("macos-arm64")],
    resumePlanRoot: ROOT_A,
    finalPublicReadbackRoot: ROOT_B,
  });
  assert.deepEqual(
    result.lineage.stageCapsules.reused.map((entry) => entry.platform),
    ["linux-x64", "macos-arm64"],
  );
  assert.deepEqual(result.lineage.stageCapsules.rebuildPlatforms, [
    "windows-x64",
  ]);
  assert.equal(result.lineage.continuation.rerunFailedJobs, false);
  assert.equal(result.lineage.attempts.build.runtimeSha, SHA_A);
  assert.equal(result.lineage.attempts.resume.runtimeSha, SHA_B);
  assert.equal(
    verifyRuntimeResumeLineage({
      lineage: result.lineage,
      lineageRoot: result.lineageRoot,
      sourceSha: SOURCE_SHA,
      consumerPolicyReceiptRoot: ROOT_C,
    }).ok,
    true,
  );
});

test("resume lineage rejects same-attempt replay and stale capsule identity", () => {
  const base = {
    repository: "kungfu-systems/consumer",

    buildAttempt: { id: "attempt-17", runtimeSha: SHA_A },
    resumeAttempt: { id: "attempt-17", runtimeSha: SHA_B },
    source: { sha: SOURCE_SHA, treeSha: TREE_SHA },
    consumerPolicyReceiptRoot: ROOT_C,
    requiredPlatforms: ["linux-x64"],
    stageCapsules: [capsule("linux-x64")],
    resumePlanRoot: ROOT_A,
    finalPublicReadbackRoot: ROOT_B,
  };
  assert.throws(
    () => createRuntimeResumeLineage(base),
    /new governed attempt/u,
  );
  const stale = structuredClone(base);
  stale.resumeAttempt.id = "attempt-18";
  stale.stageCapsules[0].sourceTreeSha = "e".repeat(40);
  assert.throws(
    () => createRuntimeResumeLineage(stale),
    /identity is stale or ambiguous/u,
  );
});

test("Release Passport embeds and revalidates runtime A+B Stage Capsule lineage", () => {
  const resume = createRuntimeResumeLineage({
    repository: "kungfu-systems/consumer",

    buildAttempt: { id: "attempt-build-17", runtimeSha: SHA_A },
    resumeAttempt: { id: "attempt-resume-18", runtimeSha: SHA_B },
    source: { sha: SOURCE_SHA, treeSha: TREE_SHA },
    consumerPolicyReceiptRoot: ROOT_C,
    requiredPlatforms: scenario.requiredPlatforms,
    stageCapsules: [capsule("linux-x64"), capsule("macos-arm64")],
    resumePlanRoot: ROOT_A,
    finalPublicReadbackRoot: ROOT_B,
  });
  const evidence = {
    lineage: resume.lineage,
    lineageRoot: resume.lineageRoot,
  };
  const validate = new Ajv2020({ strict: false }).compile(evidenceSchema);
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  const extraLineageField = structuredClone(evidence);
  extraLineageField.lineage.continuation.unexpected = true;
  assert.equal(validate(extraLineageField), false);
  assert.deepEqual(
    resume.lineage.stageCapsules.reused.map((entry) => entry.platform),
    scenario.reusedPlatforms,
  );
  assert.deepEqual(
    resume.lineage.stageCapsules.rebuildPlatforms,
    scenario.rebuildPlatforms,
  );
  const passport = createReleasePassport({
    repository: "kungfu-systems/consumer",
    tag: "v1.0.0",
    sourceSha: SOURCE_SHA,
    domainRuntimeResumeEvidence: evidence,
  });
  assert.equal(
    passport.v4RuntimeResume.lineage.attempts.build.runtimeSha,
    SHA_A,
  );
  assert.equal(
    passport.v4RuntimeResume.lineage.attempts.resume.runtimeSha,
    SHA_B,
  );
  assert.equal(passport.v4RuntimeResume.lineageRoot, resume.lineageRoot);

  const promoted = createReleasePassport({
    repository: "kungfu-systems/consumer",
    tag: "v1.0.0-alpha.1",
    sourceSha: SHA_B,
    release: {
      builtSourceSha: SOURCE_SHA,
      promotionChannelSha: SHA_B,
      treeEquivalent: true,
    },
    domainRuntimeResumeEvidence: evidence,
  });
  assert.equal(promoted.v4RuntimeResume.lineage.source.sha, SOURCE_SHA);
  assert.throws(
    () =>
      createReleasePassport({
        repository: "kungfu-systems/consumer",
        tag: "v1.0.0-alpha.1",
        sourceSha: SHA_B,
        release: {
          builtSourceSha: SOURCE_SHA,
          promotionChannelSha: SHA_B,
          treeEquivalent: false,
        },
        domainRuntimeResumeEvidence: evidence,
      }),
    /source-sha-mismatch/u,
  );

  const binaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-resume-binary-passport-"),
  );
  write(path.join(binaryRoot, "base.json"), `${JSON.stringify(passport)}\n`);
  write(path.join(binaryRoot, "assets", "buildchain.tar.gz"), "binary\n");
  const binary = collectGitHubReleasePassport({
    cwd: binaryRoot,
    repository: "kungfu-systems/consumer",
    tag: "v1.0.0",
    sourceSha: SOURCE_SHA,
    assetsDir: "assets",
    outputDir: "passport",
    basePassportJson: "base.json",
  });
  const binaryPassport = JSON.parse(
    fs.readFileSync(
      path.join(binary.outputDir, "buildchain.release.json"),
      "utf8",
    ),
  );
  assert.equal(binaryPassport.v4RuntimeResume.lineageRoot, resume.lineageRoot);
  fs.rmSync(binaryRoot, { recursive: true, force: true });

  const tampered = structuredClone(evidence);
  tampered.lineage.attempts.resume.runtimeSha = "e".repeat(40);
  assert.throws(
    () =>
      createReleasePassport({
        repository: "kungfu-systems/consumer",
        tag: "v1.0.0",
        sourceSha: SOURCE_SHA,
        domainRuntimeResumeEvidence: tampered,
      }),
    /lineage invalid: lineage-root-mismatch/u,
  );
});

test("source scan closes runtime selectors inside multiline workflow and action JSON envelopes", (t) => {
  const root = cleanConsumer();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflow = path.join(root, ".github/workflows/promotion.yml");
  const envelope = (value) =>
    `jobs:\n  promote:\n    uses: ./.github/workflows/public-release-promote.yml\n    with:\n      request-json: |\n${value
      .split("\n")
      .map((line) => `        ${line}`)
      .join("\n")}\n`;
  for (const value of [
    `{ "buildchain-ref":\n  "${SHA_B}" }`,
    `{ "buildchainRuntime": { "sha": "${SHA_B}" } }`,
    '{ "resume-buildchain-runtime-sha": "${{ vars.RUNTIME_SHA }}" }',
  ]) {
    write(workflow, envelope(value));
    const scan = scanRuntimeSelectorPersistence({ root });
    assert.equal(scan.status, "rejected");
    assert.ok(
      scan.failures.some((f) => f.code === "persistent-runtime-json-value"),
      JSON.stringify(scan.failures),
    );
  }
  write(
    workflow,
    envelope(
      '{ "buildchain-ref": "v4-alpha", "resume-buildchain-runtime-sha": ${{ toJSON(inputs.runtime_sha) }} }',
    ),
  );
  assert.equal(scanRuntimeSelectorPersistence({ root }).status, "passed");
  write(workflow, envelope('{ "buildchain-ref": '));
  assert.ok(
    scanRuntimeSelectorPersistence({ root }).failures.some(
      (f) => f.code === "runtime-selector-json-envelope-invalid",
    ),
  );
  write(workflow, envelope("${{ vars.PROMOTION_REQUEST }}"));
  assert.ok(
    scanRuntimeSelectorPersistence({ root }).failures.some(
      (f) => f.code === "persistent-runtime-json-indirection",
    ),
  );
  write(workflow, envelope('{ "buildchain-ref": "v4" }'));
  write(
    path.join(root, "actions/promotion/submit/action.yml"),
    `runs:\n  using: composite\n  steps:\n    - uses: ./.buildchain/runtime/actions/release/promotion/ref\n      with:\n        invocation-json: >\n          { "buildchain-ref":\n            "${SHA_B}" }\n`,
  );
  const actionScan = scanRuntimeSelectorPersistence({ root });
  assert.ok(
    actionScan.failures.some(
      (f) =>
        f.path === "actions/promotion/submit/action.yml" &&
        f.code === "persistent-runtime-json-value",
    ),
  );
});
