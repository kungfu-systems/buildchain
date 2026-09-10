import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectWorkflowJob } from "../scripts/workflow-action-graph.mjs";

import {
  createProductPublicationDeclaration,
  createProductPublicationPlan,
  selectProductPublicationIntent,
} from "../packages/core/release/product-publication.js";
import { domainContentRoot } from "../packages/core/contracts/canonical-contracts.js";
import { compileReleaseTailDeclaration } from "../packages/core/release/release-tail-provider-plane.js";
import { qualifyPromotionCandidate } from "../packages/core/release/promotion/candidate.js";
import { createProductPublicationAdapters } from "../packages/core/release/promote-candidate/product-provider-adapters.js";
import { selectProductPublicationPlan } from "../packages/core/release/promote-candidate/product-provider.js";

const root = path.resolve(import.meta.dirname, "..");

test("fresh and recovered product versions are selected before APPLY without provider authority", () => {
  const common = {
    channel: "alpha",
    targetRef: "alpha/v4/v4.0",
    sourceSha: "a".repeat(40),
    sourceTimestamp: "2026-08-30T00:00:00.000Z",
    repository: "kungfu-systems/buildchain",
    packageName: "@kungfu-tech/buildchain",
    distTag: "alpha",
    sealedBundleRoot: `sha256:${"1".repeat(64)}`,
    requiredArtifactsRoot: `sha256:${"2".repeat(64)}`,
    candidateVersion: "4.0.2-alpha.6",
    observedVersions: [
      "0.0.0-bootstrap.0",
      "4.0.2-alpha.5",
      "4.0.2-alpha.7",
      "3.9.0",
    ],
  };
  const fresh = selectProductPublicationIntent(common);
  assert.equal(fresh.mode, "fresh");
  assert.equal(fresh.version, "4.0.2-alpha.6");
  assert.equal(fresh.exactTag, "v4.0.2-alpha.6");
  assert.match(fresh.intentRoot, /^sha256:[0-9a-f]{64}$/u);

  const offsetTimestamp = selectProductPublicationIntent({
    ...common,
    sourceTimestamp: "2026-08-30T08:00:00+08:00",
  });
  assert.equal(offsetTimestamp.sourceTimestamp, "2026-08-30T08:00:00+08:00");

  const resume = selectProductPublicationIntent({
    ...common,
    recoveredVersion: "4.0.2-alpha.6",
  });
  assert.equal(resume.mode, "resume");
  assert.equal(resume.version, "4.0.2-alpha.6");
  assert.notEqual(resume.intentRoot, fresh.intentRoot);
  assert.throws(
    () =>
      selectProductPublicationIntent({
        ...common,
        recoveredVersion: "4.0.2-alpha.7",
      }),
    /must equal the sealed candidate version/u,
  );
});

test("one rooted product plan declares version, package, and ref effects before credentials", () => {
  const intent = selectProductPublicationIntent({
    channel: "alpha",
    targetRef: "alpha/v4/v4.0",
    sourceSha: "a".repeat(40),
    sourceTimestamp: "2026-08-30T00:00:00.000Z",
    repository: "kungfu-systems/buildchain",
    packageName: "@kungfu-tech/buildchain",
    distTag: "alpha",
    sealedBundleRoot: `sha256:${"1".repeat(64)}`,
    requiredArtifactsRoot: `sha256:${"2".repeat(64)}`,
    candidateVersion: "4.0.2-alpha.6",
    observedVersions: ["4.0.2-alpha.6"],
  });
  const plan = createProductPublicationPlan({
    intent,
    invocationRoot: `sha256:${"b".repeat(64)}`,
    transactionRoot: `sha256:${"c".repeat(64)}`,
  });
  assert.deepEqual(plan.operationOrder, [
    "product.version-state.materialize",
    "product.package.publish",
    "product.release-refs.converge",
  ]);
  assert.equal(
    plan.operations.filter(
      ({ authority }) => authority === "oidc-provider-mutation",
    ).length,
    1,
  );
  assert.deepEqual(
    plan.operations.at(-1).target.references.map(({ ref }) => ref),
    [
      "refs/tags/v4.0.2-alpha.6",
      "refs/heads/alpha/v4/v4.0",
      "refs/tags/v4.0-alpha",
      "refs/tags/v4-alpha",
    ],
  );
  assert.equal(
    plan.operations
      .at(-1)
      .target.references.every(({ target }) => target === "source"),
    true,
  );
  assert.match(plan.planRoot, /^sha256:[0-9a-f]{64}$/u);
  const declaration = createProductPublicationDeclaration({ intent, plan });
  const effectPlan = compileReleaseTailDeclaration(declaration);
  assert.deepEqual(
    effectPlan.effects.map(({ capabilityId }) => capabilityId),
    plan.operationOrder,
  );
  assert.equal(effectPlan.transactionRoot, plan.transactionRoot);
});

test("custom product publication preserves the sealed candidate version and omits npm effects", () => {
  const requiredArtifacts = [
    { kind: "custom", name: "agent-hub", required: true },
  ];
  const intent = selectProductPublicationIntent({
    channel: "alpha",
    targetRef: "alpha/v0/v0.2",
    sourceSha: "a".repeat(40),
    sourceTimestamp: "2026-09-03T00:00:00.000Z",
    repository: "kungfu-systems/sample-consumer",
    artifactKind: "custom",
    requiredArtifactsRoot: domainContentRoot(
      "v4-product-required-artifacts",
      requiredArtifacts,
    ),
    candidateVersion: "0.2.0-alpha.9",
    observedVersions: ["0.2.0-alpha.99"],
  });
  assert.equal(intent.version, "0.2.0-alpha.9");
  assert.equal(intent.exactTag, "v0.2.0-alpha.9");
  assert.equal(intent.artifactKind, "custom");
  assert.equal("packageName" in intent, false);
  assert.equal("sealedBundleRoot" in intent, false);

  const plan = createProductPublicationPlan({
    intent,
    invocationRoot: `sha256:${"b".repeat(64)}`,
    transactionRoot: `sha256:${"c".repeat(64)}`,
  });
  assert.deepEqual(plan.operationOrder, [
    "product.version-state.materialize",
    "product.release-refs.converge",
  ]);
  const declaration = createProductPublicationDeclaration({ intent, plan });
  assert.deepEqual(
    compileReleaseTailDeclaration(declaration).effects.map(
      ({ capabilityId }) => capabilityId,
    ),
    plan.operationOrder,
  );
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "custom-product-"),
  );
  const requiredArtifactsPath = path.join(
    temporaryRoot,
    "required-artifacts.json",
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "package.json"),
    JSON.stringify({ name: "sample-consumer", version: intent.version }),
  );
  fs.writeFileSync(requiredArtifactsPath, JSON.stringify(requiredArtifacts));
  const runtime = createProductPublicationAdapters({
    request: { octokit: {}, mutationOctokit: {}, requiredArtifactsPath },
    intent,
    plan,
    cwd: temporaryRoot,
  });
  assert.equal("npm-trusted-publishing" in runtime.adapters, false);
});

test("fresh and recovery candidate discovery use named APIs and preserve recovery coordinates", async () => {
 const calls = [], deps = { fresh: async value => { calls.push(["fresh", value]); return "fresh"; }, recover: async value => { calls.push(["recovery", value]); return "recovered"; } };
 const input = { request: {}, intent: { "target-ref": "alpha/v4/v4.1", "requested-sha": "a".repeat(40) }, repository: "owner/repo", runtimeSha: "b".repeat(40) };
 assert.equal(await qualifyPromotionCandidate(input, deps), "fresh");
 assert.equal(calls[0][1].runtimeSha, input.runtimeSha);
 assert.equal(await qualifyPromotionCandidate({ ...input, request: { "resume-candidate-run-id": "123", "resume-candidate-repository": "owner/repo", "resume-buildchain-runtime-sha": input.runtimeSha } }, deps), "recovered");
 assert.equal(calls[1][1].candidateRunId, "123");
 assert.equal(calls[1][1].runtimeSha, input.runtimeSha);
 assert.equal(calls[1][1].targetSha, input.intent["requested-sha"]);
 const workflow = fs.readFileSync(path.join(root, "actions/release/promotion/qualify/action.yml"), "utf8");
 assert.match(workflow, /uses: \.\/\.buildchain\/runtime\/actions\/release\/promotion\/qualify-candidate/u);
});

test("fresh and recovery APPLY use the same rooted product provider transaction", () => {
  const workflow = fs.readFileSync(
    path.join(root, "actions/release/promotion/qualify/action.yml"),
    "utf8",
  );
  const action = fs.readFileSync(
    path.join(root, "actions/release/promotion/candidate/action.yml"),
    "utf8",
  );
  const entrypoint = fs.readFileSync(
    path.join(root, "packages/core/release/promote-candidate/provider-request.js"),
    "utf8",
  );
  const provider = fs.readFileSync(
    path.join(root, "packages/core/release/promote-candidate/product-provider.js"),
    "utf8",
  );
  assert.match(workflow, /product-publication-intent-path:/u);
  const graph = inspectWorkflowJob(".github/workflows/.release-promote.yml", "qualify");
  assert.ok(graph.actions.has("actions/release/promotion/qualify-candidate"));
  assert.ok(graph.modules.has("packages/core/release/promotion/qualification.js"));
  assert.match(graph.modules.get("packages/core/release/promotion/product-state.js"), /selectRecoveredProductPublicationVersion/);
  assert.match(
    action,
    /product-publication-intent-path:[\s\S]*required: true/u,
  );
  assert.match(
    entrypoint,
    /publicationIntent: read\(request\["product-publication-intent-path"\]\)/u,
  );
  assert.match(
    provider,
    /compileReleaseTailDeclaration\(declaration\)[\s\S]*executeReleaseTailTransaction/u,
  );
  assert.doesNotMatch(provider, /promoteBuildchainRefs/u);
});

test("canonical APPLY roots the product provider's planned exact version", () => {
  assert.deepEqual(
    selectProductPublicationPlan({
      updates: [
        {
          action: "dry-run-publish-transaction",
          version: "4.0.2-alpha.3",
          tag: "v4.0.2-alpha.3",
          releaseCandidateVersion: "4.0.2-alpha.2",
        },
      ],
    }),
    {
      version: "4.0.2-alpha.3",
      tag: "v4.0.2-alpha.3",
      candidateVersion: "4.0.2-alpha.2",
    },
  );
  assert.throws(
    () =>
      selectProductPublicationPlan({
        updates: [
          {
            action: "dry-run-publish-transaction",
            version: "4.0.2-alpha.3",
            tag: "v22.22.3-kf.0",
          },
        ],
      }),
    /mismatched exact tag/u,
  );
});

test("anchored alpha package sets bind every package and publish platforms before main", () => {
  const version = "22.22.3-kf.5-alpha.4";
  const packages = [
    ["@kungfu-tech/libnode", "main"],
    ["@kungfu-tech/libnode-linux-x64", "platform"],
    ["@kungfu-tech/libnode-darwin-arm64", "platform"],
  ].map(([name, role], index) => ({
    name,
    role,
    version,
    path: `${index}.tgz`,
    integrity: `sha512-${index}`,
    sha256: `sha256:${String(index).repeat(64)}`,
  }));
  const input = {
    channel: "alpha",
    targetRef: "alpha/v22/v22.22",
    sourceSha: "a".repeat(40),
    sourceTimestamp: "2026-09-06T00:00:00.000Z",
    repository: "kungfu-systems/libnode",
    packageName: "@kungfu-tech/libnode",
    distTag: "alpha",
    candidateVersion: version,
    sealedBundleRoot: `sha256:${"1".repeat(64)}`,
    requiredArtifactsRoot: `sha256:${"2".repeat(64)}`,
    observedVersions: [],
    npmPackages: packages,
  };
  const intent = selectProductPublicationIntent(input);
  assert.equal(intent.version, version);
  assert.deepEqual(
    intent.npmPackages.map(({ name }) => name),
    [packages[2].name, packages[1].name, packages[0].name],
  );
  assert.equal(
    selectProductPublicationIntent({
      ...input,
      npmPackages: [...packages].reverse(),
    }).intentRoot,
    intent.intentRoot,
  );
  const plan = createProductPublicationPlan({
    intent,
    invocationRoot: `sha256:${"3".repeat(64)}`,
    transactionRoot: `sha256:${"4".repeat(64)}`,
  });
  assert.deepEqual(
    plan.operations.slice(1, -1).map(({ target }) => target.package),
    intent.npmPackages,
  );
  assert.equal(
    new Set(plan.operations.map(({ operationRoot }) => operationRoot)).size,
    5,
  );
  const effects = compileReleaseTailDeclaration(
    createProductPublicationDeclaration({ intent, plan }),
  );
  assert.deepEqual(
    effects.effects.map(({ capabilityId }) => capabilityId),
    plan.operationOrder,
  );
  for (const invalid of [
    [...packages, packages[0]],
    packages.map((entry, index) =>
      index === 1 ? { ...entry, version: "22.22.3-kf.5-alpha.5" } : entry,
    ),
    packages.filter(({ role }) => role !== "main"),
    packages.map((entry) => ({ ...entry, role: "main" })),
  ])
    assert.throws(
      () =>
        selectProductPublicationIntent({ ...input, npmPackages: invalid }),
      /npmPackages/u,
    );
  assert.throws(
    () =>
      selectProductPublicationIntent({
        ...input,
        channel: "stable",
        targetRef: "release/v22/v22.22",
      }),
    /alpha publication/u,
  );
  assert.notEqual(
    selectProductPublicationIntent({
      ...input,
      npmPackages: packages.map((entry, index) =>
        index === 1 ? { ...entry, sha256: `sha256:${"f".repeat(64)}` } : entry,
      ),
    }).intentRoot,
    intent.intentRoot,
  );
});
