import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNoV4ExecutionFields,
  assertV4DeclarativePromotionInputs,
  createV4PublicationQualificationReceipt,
  validateV4PublicationQualificationReceipt,
} from "../packages/core/v4-publication-qualification.js";
import { admitV4DeclarativePromotion } from "../scripts/v4-declarative-promotion-admission.mjs";
import { createDeclarativeGitHubReleasePlan } from "../actions/promote-buildchain-ref/github-release.js";
import { publishDeclarativeGitHubReleaseEvidence } from "../actions/promote-buildchain-ref/github-release.js";

const root = (character) => `sha256:${character.repeat(64)}`;
const base = () => ({
  repository: "kungfu-systems/buildchain",
  candidateRoot: root("1"),
  sourceSha: "2".repeat(40),
  sourceRoot: root("3"),
  policyDigest: root("4"),
  artifacts: [
    {
      role: "installable-product",
      platform: "linux-x64",
      artifactRoot: root("5"),
      manifestRoot: root("6"),
    },
  ],
  issuedAt: "2026-08-26T00:00:00.000Z",
  expiresAt: "2026-08-27T00:00:00.000Z",
});

function code(expected, callback) {
  assert.throws(callback, (error) => error.code === expected);
}

test("valid qualification binds candidate source artifacts policy and freshness", () => {
  const receipt = createV4PublicationQualificationReceipt(base());
  assert.equal(
    validateV4PublicationQualificationReceipt(receipt, {
      candidateRoot: root("1"),
      sourceRoot: root("3"),
      artifactRoot: receipt.artifactRoot,
      policyDigest: root("4"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }).ok,
    true,
  );
});

test("missing, tampered, stale, candidate mismatch, and policy mismatch fail closed", () => {
  const receipt = createV4PublicationQualificationReceipt(base());
  code("qualification-missing", () =>
    validateV4PublicationQualificationReceipt(),
  );
  code("qualification-tampered", () =>
    validateV4PublicationQualificationReceipt({
      ...receipt,
      sourceSha: "9".repeat(40),
    }),
  );
  code("qualification-stale", () =>
    validateV4PublicationQualificationReceipt(receipt, {
      evaluatedAt: "2026-08-27T00:00:00.000Z",
    }),
  );
  code("candidate-mismatch", () =>
    validateV4PublicationQualificationReceipt(receipt, {
      candidateRoot: root("8"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }),
  );
  code("source-mismatch", () =>
    validateV4PublicationQualificationReceipt(receipt, {
      sourceRoot: root("8"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }),
  );
  code("artifact-mismatch", () =>
    validateV4PublicationQualificationReceipt(receipt, {
      artifactRoot: root("8"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }),
  );
  code("policy-mismatch", () =>
    validateV4PublicationQualificationReceipt(receipt, {
      policyDigest: root("8"),
      evaluatedAt: "2026-08-26T12:00:00.000Z",
    }),
  );
});

test("execution-shaped fields and legacy command inputs are rejected at admission", () => {
  code("execution-field-forbidden", () =>
    assertNoV4ExecutionFields({ nested: { run: "echo bypass" } }),
  );
  code("legacy-command-input-forbidden", () =>
    assertV4DeclarativePromotionInputs({
      "publication-gate-command": "node gate.js",
    }),
  );
  assert.doesNotThrow(() =>
    assertV4DeclarativePromotionInputs({ "dry-run": true }),
  );
});

test("v4 admission requires declarative mode while v3 remains compatible", () => {
  assert.deepEqual(
    admitV4DeclarativePromotion({
      runtimeRef: "v3",
      inputs: { "publish-command": "npm publish" },
      declarative: false,
    }),
    { mode: "legacy", admitted: true },
  );
  code("v4-declarative-release-tail-required", () =>
    admitV4DeclarativePromotion({
      runtimeRef: "v4",
      inputs: {},
      declarative: false,
    }),
  );
  code("legacy-command-input-forbidden", () =>
    admitV4DeclarativePromotion({
      runtimeRef: "v4",
      inputs: { "publish-command": "npm publish" },
      declarative: true,
    }),
  );
});

test("v4 Provider Plane publishes rooted invocation transaction and receipt evidence", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/.release-candidate-promote.yml", import.meta.url),
    "utf8",
  );
  const apply = workflow.slice(
    workflow.indexOf("\n  apply:"),
    workflow.indexOf("\n  settle:"),
  );
  const settle = workflow.slice(workflow.indexOf("\n  settle:"));

  assert.match(
    apply,
    /uses: \.\/\.buildchain\/runtime\/actions\/v4-release-candidate-promote/,
  );
  assert.match(apply, /release-invocation-root:/);
  assert.match(apply, /release-transaction-root:/);
  assert.match(apply, /release-receipt-root:/);
  assert.match(
    apply,
    /name: buildchain-v4-release-apply-\$\{\{ needs\.qualify\.outputs\.requested-sha \}\}/,
  );
  assert.match(settle, /release-receipt\.json/);
  assert.doesNotMatch(apply, /declarative-controller-evidence/u);
});

test("qualified v4 release materializes the four built-in provider capabilities", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-tail-"),
  );
  try {
    const asset = path.join(directory, "buildchain.release.json");
    fs.writeFileSync(asset, "{}\n");
    const legacy = createDeclarativeGitHubReleasePlan({
      repository: "kungfu-systems/buildchain",
      sourceSha: "a".repeat(40),
      version: "3.0.0",
      tag: "v3.0.0",
      channel: "stable",
      assetPaths: [asset],
    });
    assert.deepEqual(
      legacy.plan.effects.map(({ capabilityId }) => capabilityId),
      ["artifact.publish"],
    );
    const result = createDeclarativeGitHubReleasePlan({
      repository: "kungfu-systems/buildchain",
      sourceSha: "a".repeat(40),
      version: "4.0.0-alpha.1",
      tag: "v4.0.0-alpha.1",
      channel: "alpha",
      assetPaths: [asset],
      qualificationRoot: root("b"),
    });
    assert.deepEqual(
      result.plan.effects.map(({ capabilityId }) => capabilityId),
      [
        "artifact.publish",
        "signed-channel.commit",
        "release.activate",
        "released-evidence.synthesize",
      ],
    );
    assert.equal(
      new Set(result.plan.effects.map(({ transactionRoot }) => transactionRoot))
        .size,
      1,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fakeGitHub() {
  const state = {
    release: null,
    assets: [],
    refs: new Map(),
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
    documents: new Map(),
    mutations: 0,
  };
  const missing = () =>
    Promise.reject(Object.assign(new Error("missing"), { status: 404 }));
  const materialize = (ref, sha) => {
    const tree = state.trees.get(state.commits.get(sha));
    for (const entry of tree || []) {
      state.documents.set(`${ref}:${entry.path}`, state.blobs.get(entry.sha));
    }
  };
  return {
    state,
    octokit: {
      rest: {
        repos: {
          getReleaseByTag: () =>
            state.release
              ? Promise.resolve({ data: state.release })
              : missing(),
          listReleaseAssets: () => Promise.resolve({ data: state.assets }),
          createRelease: () => {
            state.release = { id: 1, html_url: "https://example.test/release" };
            state.mutations += 1;
            return Promise.resolve({ data: state.release });
          },
          uploadReleaseAsset: ({ name, data }) => {
            state.assets.push({
              name,
              digest: `sha256:${crypto.createHash("sha256").update(data).digest("hex")}`,
            });
            return Promise.resolve({ data: state.assets.at(-1) });
          },
          getContent: ({ ref, path: file }) =>
            state.documents.has(`${ref}:${file}`)
              ? Promise.resolve({
                  data: {
                    type: "file",
                    content: Buffer.from(
                      JSON.stringify(state.documents.get(`${ref}:${file}`)),
                    ).toString("base64"),
                  },
                })
              : missing(),
        },
        git: {
          getRef: ({ ref }) =>
            state.refs.has(ref)
              ? Promise.resolve({
                  data: { object: { sha: state.refs.get(ref) } },
                })
              : missing(),
          getCommit: ({ commit_sha: sha }) =>
            Promise.resolve({
              data: { tree: { sha: state.commits.get(sha) } },
            }),
          createBlob: ({ content }) => {
            const sha = `blob-${state.blobs.size}`;
            state.blobs.set(sha, JSON.parse(content));
            return Promise.resolve({ data: { sha } });
          },
          createTree: ({ tree }) => {
            const sha = `tree-${state.trees.size}`;
            state.trees.set(sha, tree);
            return Promise.resolve({ data: { sha } });
          },
          createCommit: ({ tree }) => {
            const sha = `commit-${state.commits.size}`;
            state.commits.set(sha, tree);
            return Promise.resolve({ data: { sha } });
          },
          createRef: ({ ref, sha }) => {
            const key = ref.replace(/^refs\//u, "");
            state.refs.set(key, sha);
            materialize(key.replace(/^heads\//u, ""), sha);
            state.mutations += 1;
            return Promise.resolve({});
          },
          updateRef: ({ ref, sha }) => {
            state.refs.set(ref, sha);
            materialize(ref.replace(/^heads\//u, ""), sha);
            state.mutations += 1;
            return Promise.resolve({});
          },
        },
      },
    },
  };
}

test("v4 provider checkpoint resumes only the incomplete tail after injected failure", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-resume-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const passportDir = path.join(directory, "passport");
  fs.mkdirSync(passportDir);
  const evidence = path.join(directory, "publication-evidence.json");
  const passport = path.join(passportDir, "buildchain.release.json");
  fs.writeFileSync(evidence, '{"evidence":true}\n');
  fs.writeFileSync(passport, '{"passport":true}\n');
  const github = fakeGitHub();
  const options = {
    octokit: github.octokit,
    repository: "kungfu-systems/buildchain",
    sourceSha: "a".repeat(40),
    version: "4.0.0-alpha.1",
    tag: "v4.0.0-alpha.1",
    channel: "alpha",
    publishEvidencePath: evidence,
    releasePassportPath: passport,
    releasePassportOutputDir: passportDir,
    statePath: path.join(directory, "state.json"),
    qualificationRoot: root("b"),
  };
  await assert.rejects(
    publishDeclarativeGitHubReleaseEvidence({
      ...options,
      failureAfterCapability: "artifact.publish",
    }),
    /injected provider failure/u,
  );
  const interrupted = JSON.parse(fs.readFileSync(options.statePath, "utf8"));
  assert.deepEqual(
    interrupted.receipts.map(({ capabilityId }) => capabilityId),
    ["artifact.publish"],
  );
  const resumed = await publishDeclarativeGitHubReleaseEvidence(options);
  assert.equal(resumed.transaction.state, "complete");
  assert.deepEqual(
    resumed.transaction.receipts.map(({ capabilityId }) => capabilityId),
    [
      "artifact.publish",
      "signed-channel.commit",
      "release.activate",
      "released-evidence.synthesize",
    ],
  );
  assert.equal(github.state.mutations, 3);
});
