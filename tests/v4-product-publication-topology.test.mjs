import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createV4ProductPublicationDeclaration,
  createV4ProductPublicationPlan,
  selectV4ProductPublicationIntent,
} from "../packages/core/v4-product-publication.js";
import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";
import { compileReleaseTailDeclaration } from "../packages/core/release-tail-provider-plane.js";
import { resolveV4ReleaseCandidateAdapter } from "../scripts/v4-release-candidate-adapter.mjs";
import { createV4ProductPublicationAdapters } from "../actions/v4-release-candidate-promote/product-provider-adapters.js";
import { selectProductPublicationPlan } from "../actions/v4-release-candidate-promote/product-provider.js";

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
  const fresh = selectV4ProductPublicationIntent(common);
  assert.equal(fresh.mode, "fresh");
  assert.equal(fresh.version, "4.0.2-alpha.6");
  assert.equal(fresh.exactTag, "v4.0.2-alpha.6");
  assert.match(fresh.intentRoot, /^sha256:[0-9a-f]{64}$/u);

  const resume = selectV4ProductPublicationIntent({
    ...common,
    recoveredVersion: "4.0.2-alpha.6",
  });
  assert.equal(resume.mode, "resume");
  assert.equal(resume.version, "4.0.2-alpha.6");
  assert.notEqual(resume.intentRoot, fresh.intentRoot);
  assert.throws(
    () =>
      selectV4ProductPublicationIntent({
        ...common,
        recoveredVersion: "4.0.2-alpha.7",
      }),
    /must equal the sealed candidate version/u,
  );
});

test("one rooted product plan declares version, package, and ref effects before credentials", () => {
  const intent = selectV4ProductPublicationIntent({
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
  const plan = createV4ProductPublicationPlan({
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
  const declaration = createV4ProductPublicationDeclaration({ intent, plan });
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
  const intent = selectV4ProductPublicationIntent({
    channel: "alpha",
    targetRef: "alpha/v0/v0.2",
    sourceSha: "a".repeat(40),
    sourceTimestamp: "2026-09-03T00:00:00.000Z",
    repository: "kungfu-systems/agent-hub-demo",
    artifactKind: "custom",
    requiredArtifactsRoot: v4ContentRoot(
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

  const plan = createV4ProductPublicationPlan({
    intent,
    invocationRoot: `sha256:${"b".repeat(64)}`,
    transactionRoot: `sha256:${"c".repeat(64)}`,
  });
  assert.deepEqual(plan.operationOrder, [
    "product.version-state.materialize",
    "product.release-refs.converge",
  ]);
  const declaration = createV4ProductPublicationDeclaration({ intent, plan });
  assert.deepEqual(
    compileReleaseTailDeclaration(declaration).effects.map(
      ({ capabilityId }) => capabilityId,
    ),
    plan.operationOrder,
  );
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "v4-custom-product-"),
  );
  const requiredArtifactsPath = path.join(
    temporaryRoot,
    "required-artifacts.json",
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "package.json"),
    JSON.stringify({ name: "agent-hub-demo", version: intent.version }),
  );
  fs.writeFileSync(requiredArtifactsPath, JSON.stringify(requiredArtifacts));
  const runtime = createV4ProductPublicationAdapters({
    request: { octokit: {}, mutationOctokit: {}, requiredArtifactsPath },
    intent,
    plan,
    cwd: temporaryRoot,
  });
  assert.equal("npm-trusted-publishing" in runtime.adapters, false);
});

test("fresh and recovery candidate discovery are data-only adapters into the same APPLY engine", () => {
  assert.deepEqual(resolveV4ReleaseCandidateAdapter(), {
    mode: "fresh",
    script: "scripts/release-candidate-resolver.mjs",
  });
  assert.deepEqual(
    resolveV4ReleaseCandidateAdapter({ resumeCandidateRunId: "123" }),
    {
      mode: "recovery",
      script: "scripts/resume-from-candidate-run.mjs",
    },
  );
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /run: node \.buildchain\/runtime\/scripts\/v4-release-candidate-adapter\.mjs/u,
  );
  assert.doesNotMatch(
    workflow,
    /if \[ -n "\$BUILDCHAIN_RESUME_CANDIDATE_RUN_ID" \]/u,
  );
});

test("fresh and recovery APPLY use the same rooted product provider transaction", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const action = fs.readFileSync(
    path.join(root, "actions/v4-release-candidate-promote/action.yml"),
    "utf8",
  );
  const entrypoint = fs.readFileSync(
    path.join(root, "actions/v4-release-candidate-promote/index.js"),
    "utf8",
  );
  const provider = fs.readFileSync(
    path.join(root, "actions/v4-release-candidate-promote/product-provider.js"),
    "utf8",
  );
  assert.match(workflow, /product-publication-intent-path:/u);
  assert.match(
    workflow,
    /BUILDCHAIN_CANDIDATE_VERSION: \$\{\{ steps\.candidate\.outputs\.release-candidate-publication-version \|\| steps\.candidate\.outputs\.release-candidate-version \}\}/u,
  );
  assert.match(
    workflow,
    /name: Resolve one exact product publication recovery[\s\S]*selectV4RecoveredProductPublicationVersion[\s\S]*BUILDCHAIN_RECOVERED_PUBLICATION_VERSION: \$\{\{ steps\.recovery\.outputs\.version \|\| '' \}\}/u,
  );
  assert.match(
    action,
    /product-publication-intent-path:[\s\S]*required: true/u,
  );
  assert.match(
    entrypoint,
    /publicationIntent: read\(input\("product-publication-intent-path", true\)\)/u,
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
