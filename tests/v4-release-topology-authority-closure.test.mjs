import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { findUnknownV4ReleaseTopology } from "../scripts/check-v4-release-topology.mjs";

const root = path.resolve(import.meta.dirname, "..");
const topologyLedger = JSON.parse(
  fs.readFileSync(
    new URL("../architecture/v4-release-topology.json", import.meta.url),
    "utf8",
  ),
);

test("fresh, recovery, and startup-failure routes cannot reach a legacy release engine", () => {
  const canonical = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const publicWrapper = fs.readFileSync(
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
    "utf8",
  );
  const recovery = fs.readFileSync(
    path.join(root, ".github/workflows/buildchain-ref-promotion-recovery.yml"),
    "utf8",
  );
  const promoteRelease = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/internal/promote-release-channel.js"),
    "utf8",
  );
  assert.deepEqual(topologyLedger.authorityClosure.runtimeEngines, [
    "actions/v4-release-candidate-promote/index.js",
  ]);
  assert.doesNotMatch(
    [canonical, publicWrapper, recovery].join("\n"),
    /legacy-promote|v4-declarative-promote/u,
  );
  assert.match(
    canonical,
    /uses: \.\/\.buildchain\/runtime\/actions\/v4-release-candidate-promote/u,
  );
  assert.match(
    canonical,
    /source-sha: \$\{\{ needs\.qualify\.outputs\.requested-sha \}\}/u,
  );
  assert.match(
    publicWrapper,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.release-candidate-promote\.yml@/u,
  );
  assert.match(
    recovery,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/release-candidate-promote\.yml@/u,
  );
  assert.match(
    promoteRelease,
    /recoveredCandidate: Boolean\(state\.containsPublishedMaterial\)/u,
  );
});

test("closed-world discovery rejects an undeclared release topology workflow", () => {
  assert.deepEqual(
    findUnknownV4ReleaseTopology(
      ["known.yml"],
      ["known.yml", "new.yml", "unrelated.yml"],
      (relative) =>
        relative === "new.yml"
          ? "uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v4"
          : "jobs:\n  check:\n    runs-on: ubuntu-24.04\n",
    ),
    ["new.yml"],
  );
});

test("fork governance retains a credential-limited receipt without claiming authority", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/github-governance-audit.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /name: Mint bounded governance auditor token[\s\S]+KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY != ''[\s\S]+continue-on-error: true/,
  );
  assert.match(
    workflow,
    /GH_TOKEN: \$\{\{ steps\.auditor\.outputs\.token \|\| secrets\.BUILDCHAIN_GOVERNANCE_READ_TOKEN \|\| github\.token \}\}/,
  );
  assert.match(
    workflow,
    /FORK_PULL_REQUEST:[\s\S]+github\.event\.pull_request\.head\.repo\.fork[\s\S]+Fork PR governance is credential-limited/,
  );
});

test("fork pull requests cannot enter the release fixture authority path", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/build-surface-fixture.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /libnode-shaped:\n    if: \$\{\{ github\.event_name != 'pull_request' \|\| !github\.event\.pull_request\.head\.repo\.fork \}\}/,
  );
});
