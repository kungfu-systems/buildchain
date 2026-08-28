import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  PublicationRehearsalError,
  createPublicationRehearsalCapsule,
  executePublicationRehearsal,
  normalizePublicationRehearsalCapsule,
  publicationRehearsalBindingRoot,
  publicationRehearsalDiagnostic,
} from "../packages/core/publication-rehearsal-runtime.js";
import {
  assertPublicationRehearsalConfig,
  publicationRehearsalAgentInstructions,
  publicationRehearsalToml,
  publicationRehearsalWorkflow,
} from "../packages/core/publication-rehearsal-projection.js";
import { releasePassportKfdAdopterSourceSha } from "../packages/core/release-passport.js";
import { V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT } from "../packages/core/v4-publication-rehearsal.js";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function v4CreationInput(capsule) {
  return {
    source: {
      repository: capsule.source.repository,
      revision: capsule.source.revision,
    },
    declaration: capsule.declaration,
    transaction: capsule.transaction,
    manifest: capsule.manifest,
    config: capsule.config,
    providerBindings: capsule.providerBindings,
    providerPolicy: capsule.providerPolicy,
    expectedObservations: capsule.expectedObservations.entries,
    files: capsule.files,
  };
}

test("historical publication rehearsal runtime names delegate to the exact v4 capsule contract", () => {
  const capsule = readJson(
    "contracts/fixtures/v4-publication-rehearsal-v1/capsule.json",
  );
  assert.equal(
    PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
    V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  );
  assert.equal(
    createPublicationRehearsalCapsule(v4CreationInput(capsule)).capsuleRoot,
    capsule.capsuleRoot,
  );
  assert.equal(
    normalizePublicationRehearsalCapsule(capsule).capsuleRoot,
    capsule.capsuleRoot,
  );
  assert.equal(publicationRehearsalBindingRoot(capsule), capsule.capsuleRoot);
});

test("unsafe v3 capsule construction produces a rooted executable migration route", () => {
  let caught;
  assert.throws(
    () => createPublicationRehearsalCapsule({ declaration: {} }),
    (error) => {
      caught = error;
      return error instanceof PublicationRehearsalError;
    },
  );
  assert.equal(caught.migration.status, "migration-required");
  assert.equal(
    caught.migration.replacement.module,
    "@kungfu-tech/buildchain/v4-publication-rehearsal",
  );
  assert.match(caught.migration.migrationRoot, /^sha256:[0-9a-f]{64}$/u);
  const diagnostic = publicationRehearsalDiagnostic(caught);
  assert.equal(
    diagnostic.migration.migrationRoot,
    caught.migration.migrationRoot,
  );
  assert.equal(diagnostic.productionAuthority, false);
  assert.match(diagnostic.diagnosticRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("historical execute name rejects ambient semantics before delegating to v4", async () => {
  await assert.rejects(
    () =>
      executePublicationRehearsal({
        capsule: {},
        capsuleRoot: "/tmp",
        environment: { GITHUB_SHA: "ambient" },
      }),
    (error) =>
      error instanceof PublicationRehearsalError &&
      error.rehearsalCode === "undeclared-environment" &&
      error.migration?.reasonCode === "ambient-environment-forbidden",
  );
});

test("historical projection names emit only current v4 configuration and workflow inputs", () => {
  const toml = publicationRehearsalToml();
  const config = {
    publication_rehearsal: Object.fromEntries(
      toml
        .split("\n")
        .slice(1)
        .filter(Boolean)
        .map((line) => {
          const [key, ...value] = line.split(" = ");
          return [key, JSON.parse(value.join(" = "))];
        }),
    ),
  };
  assert.equal(
    assertPublicationRehearsalConfig(config).contract,
    V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  );
  assert.match(toml, /candidate_root/u);
  assert.doesNotMatch(toml, /capsule_root/u);
  assert.match(
    publicationRehearsalAgentInstructions(),
    /production authority/u,
  );
  const workflow = publicationRehearsalWorkflow("v4");
  assert.match(workflow, /rehearsal-capsule-path:/u);
  assert.match(workflow, /candidate-root:/u);
  assert.doesNotMatch(workflow, /capsule-contract:/u);
});

test("release passport source compatibility helper remains tree-equivalence bounded", () => {
  const passportSourceSha = "a".repeat(40);
  const candidateSourceSha = "b".repeat(40);
  const treeSha = "c".repeat(40);
  const release = {
    treeEquivalent: true,
    candidateSourceSha,
    builtSourceSha: candidateSourceSha,
    promotionChannelSha: passportSourceSha,
    candidateSourceTreeSha: treeSha,
    builtSourceTreeSha: treeSha,
    promotionChannelTreeSha: treeSha,
  };
  assert.equal(
    releasePassportKfdAdopterSourceSha({ passportSourceSha, release }),
    candidateSourceSha,
  );
  release.promotionChannelTreeSha = "d".repeat(40);
  assert.equal(
    releasePassportKfdAdopterSourceSha({ passportSourceSha, release }),
    passportSourceSha,
  );
});

test("historical CLI, Action, and workflow inputs have bounded v4 routes", () => {
  const sources = new Map(
    [
      "scripts/buildchain-cli-help.mjs",
      "scripts/release-tail.mjs",
      "bin/internal/trust-release-release-handlers.mjs",
      "actions/release-tail/action.yml",
      "actions/release-tail/index.js",
      "actions/promote-buildchain-ref/action.yml",
      "actions/promote-buildchain-ref/index.js",
      ".github/workflows/.build.yml",
      ".github/workflows/.web-surface.yml",
      ".github/workflows/.release-candidate-promote.yml",
      ".github/workflows/release-candidate-promote.yml",
      ".github/workflows/dev-pr-auto-merge.yml",
      ".github/workflows/release-tail.yml",
    ].map((filePath) => [filePath, fs.readFileSync(filePath, "utf8")]),
  );
  assert.match(sources.get("scripts/release-tail.mjs"), /capsule-root/u);
  assert.match(sources.get("scripts/release-tail.mjs"), /environment-json/u);
  assert.match(
    sources.get("bin/internal/trust-release-release-handlers.mjs"),
    /--adopter-delivery-json is non-authoritative in v4/u,
  );
  assert.match(
    sources.get("actions/promote-buildchain-ref/index.js"),
    /plan-before-target-advance cannot bypass the v4 source lock/u,
  );
  assert.match(
    sources.get("actions/promote-buildchain-ref/index.js"),
    /v4 derives the adopter manifest gate/u,
  );
  assert.match(
    sources.get(".github/workflows/.build.yml"),
    /steps\.expected-identity\.outputs\.expected-channel/u,
  );
  assert.match(
    sources.get(".github/workflows/dev-pr-auto-merge.yml"),
    /Exact required Warrant qualified; landing is explicitly deferred/u,
  );
  assert.match(
    sources.get(".github/workflows/release-tail.yml"),
    /binding-root:/u,
  );
  assert.match(
    sources.get(".github/workflows/release-tail.yml"),
    /evidence-root:/u,
  );
});
