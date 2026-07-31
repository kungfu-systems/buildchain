import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("active runtime defaults use the v3 baseline", () => {
  const expectations = new Map([
    [".github/workflows/.build.yml", ["BUILDCHAIN_DEFAULT_REF: v3", 'BUILDCHAIN_DEFAULT_REF || "v3"']],
    [".github/workflows/.web-surface.yml", ["BUILDCHAIN_DEFAULT_REF: v3", 'BUILDCHAIN_DEFAULT_REF || "v3"']],
    ["packages/core/buildchain-contract.js", ['buildchainRefDefault: "workflow-shell-ref-or-v3"', 'buildchainRef = "v3"']],
    ["packages/core/paper.js", ['buildchainRef = "v3"']],
    ["scripts/buildchain-contract-lock.mjs", ['BUILDCHAIN_RUNTIME_REF", "v3"']],
    ["scripts/paper.mjs", ['buildchainRef = "v3"']],
  ]);

  for (const [relativePath, requiredTokens] of expectations) {
    const contents = source(relativePath);
    for (const token of requiredTokens) {
      assert.ok(contents.includes(token), `${relativePath} must contain ${token}`);
    }
  }

  for (const relativePath of expectations.keys()) {
    assert.doesNotMatch(
      source(relativePath),
      /(?:BUILDCHAIN_DEFAULT_REF:|BUILDCHAIN_DEFAULT_REF \|\||BUILDCHAIN_RUNTIME_REF",|buildchainRef(?:Default)?\s*[=:])[^,\n]*v2/,
      `${relativePath} must not retain an implicit v2 runtime default`,
    );
  }
});

test("manual binary evidence defaults to an existing v3 exact tag", () => {
  assert.match(
    source(".github/workflows/binary-distribution.yml"),
    /default: "v3\.0\.2-alpha\.4"/,
  );
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
    "actions/promote-buildchain-ref/README.md",
    "actions/report-buildchain-issue/README.md",
    "actions/validate-config/README.md",
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
  const releaseCandidate = source("packages/core/release-candidate.js");
  const publicationAuthority = source("packages/core/publication-authority.js");
  const promoteAction = source("actions/promote-buildchain-ref/action.yml");
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
