import YAML from "yaml";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("current runtime defaults use v4 with no historical producer fallback", () => {
  for (const [file, token] of [
    ["packages/core/contracts/buildchain-contract.js", 'buildchainRef = "v4"'],
    ["packages/core/paper/paper.js", 'buildchainRef = "v4"'],
    ["packages/core/contracts/commands/buildchain-contract-lock.mjs", 'env("BUILDCHAIN_RUNTIME_REF", "v4")'],
  ]) {
    assert.ok(source(file).includes(token));
    assert.doesNotMatch(source(file), /(?:buildchainRef\s*[=:]|BUILDCHAIN_RUNTIME_REF",)[^,\n]*"v3"/);
  }
});

test("binary evidence requires an explicit exact current tag instead of a historical default", () => {
  const workflow = YAML.parse(source(".github/workflows/self-build-binary-distribution.yml"));
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.default, undefined);
  assert.deepEqual(workflow.on.push.tags, ["v4.*.*", "v4.*.*-alpha.*"]);
});

test("current manuals and action references use v3 examples", () => {
  const currentDocuments = [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/MAP.md",
    "docs/cli.md",
    "docs/consumer-issue-reporting.md",
    "docs/github-governance-authority.md",
    "docs/lifecycle-protocol.md",
    "docs/ownership.md",
    "docs/publication-authority.md",
    "docs/publish-transaction.md",
    "docs/release-flow.md",
    "docs/release-governance.md",
    "docs/reusable-build-surface.md",
    "docs/runtime-train-validation.md",
    "docs/stable-candidate-patrol.md",
    "actions/release/promote-ref/README.md",
    "actions/governance/report-issue/README.md",
    "actions/build/validate-config/README.md",
  ];
  const staleBuildchainBaseline =
    /Buildchain v2|(?:dev|alpha|release|train)\/v2\/|`v2(?:-alpha|\.\d+)?`|workflow-shell-ref-or-v2/;

  for (const relativePath of currentDocuments) {
    assert.doesNotMatch(
      source(relativePath),
      staleBuildchainBaseline,
      `${relativePath} must use v3 as the current Buildchain baseline`,
    );
  }
});

test("the v2 inventory is explicitly historical and points to v3", () => {
  const inventory = source("docs/migration-inventory.md");
  assert.match(inventory, /status: historical/);
  assert.match(inventory, /Buildchain v3 is now the active monorepo source of truth/);
  assert.match(inventory, /## Current v3 Refs/);
});

test("the v2 train-only Initiative-family release handoff is present on v3", () => {
  const releaseCandidate = source("packages/core/release/release-candidate.js");
  const publicationAuthority = source("packages/core/publication/publication-authority.js");
  const promoteAction = source("actions/release/promote-ref/action.yml");
  const retrospective = source(".github/retrospectives/2026-07-31-buildchain-v2-v3-parity.md");

  assert.match(
    releaseCandidate,
    /kungfu-buildchain-initiative-family-release-evidence\/v1/,
  );
  assert.match(releaseCandidate, /\.\.\.\(candidate\.familyEvidence \? \{ familyEvidence:/);
  assert.match(publicationAuthority, /\.\.\.\(passport\.familyEvidence \? \{ familyEvidence:/);
  assert.match(promoteAction, /release-candidate-family-evidence-required:/);
  assert.match(retrospective, /all 992 fetched remote refs and tags/);
  assert.match(retrospective, /train\/v2\/v2\.3\/go-family-release-handoff/);
});
