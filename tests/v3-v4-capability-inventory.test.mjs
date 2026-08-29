import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  V3_V4_CAPABILITY_CUTS,
  assertV3V4CapabilityInventory,
  buildV3V4CapabilityInventory,
} from "../scripts/check-v3-v4-capability-inventory.mjs";
import {
  assertCapabilityCutAncestor,
  ensureCapabilityCutAncestor,
  ensureCapabilityCutLineage,
} from "../scripts/v3-v4-capability-catalog.mjs";

function runGit(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

test("live v4 cut has an admitted lineage from the checked candidate", () => {
  const lineage = ensureCapabilityCutLineage({
    revision: V3_V4_CAPABILITY_CUTS.liveV4,
    label: "live v4 capability cut",
  });
  assert.ok(
    ["direct-ancestry", "protected-tree-equivalent"].includes(lineage.mode),
  );
  assert.throws(
    () =>
      assertCapabilityCutAncestor({
        revision: "HEAD",
        descendant: V3_V4_CAPABILITY_CUTS.liveV4,
        label: "reversed test cut",
      }),
    /must be an ancestor/u,
  );
});

test("live v4 ancestry is hydrated in a bounded shallow checkout", () => {
  const sandbox = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-capability-cut-shallow-"),
  );
  const source = path.join(sandbox, "source");
  const remote = path.join(sandbox, "remote.git");
  const shallow = path.join(sandbox, "shallow");
  fs.mkdirSync(source);
  runGit(source, ["init", "--initial-branch=main"]);
  runGit(source, ["config", "user.name", "Buildchain Test"]);
  runGit(source, ["config", "user.email", "buildchain@example.invalid"]);
  for (const value of ["base", "cut", "candidate"]) {
    fs.writeFileSync(path.join(source, "state.txt"), `${value}\n`);
    runGit(source, ["add", "state.txt"]);
    runGit(source, ["commit", "-m", value]);
  }
  const cut = runGit(source, ["rev-parse", "HEAD^"]);
  runGit(sandbox, ["init", "--bare", remote]);
  runGit(source, ["remote", "add", "origin", remote]);
  runGit(source, ["push", "origin", "main"]);
  runGit(sandbox, [
    "clone",
    "--no-tags",
    "--depth=1",
    "--branch=main",
    `file://${remote}`,
    shallow,
  ]);
  runGit(shallow, ["fetch", "--no-tags", "--depth=1", "origin", cut]);
  assert.throws(
    () => assertCapabilityCutAncestor({ root: shallow, revision: cut }),
    /must be an ancestor/u,
  );
  assert.doesNotThrow(() =>
    ensureCapabilityCutAncestor({ root: shallow, revision: cut }),
  );
});

test("tree-equivalent alpha candidates use the protected v4 lineage as a bounded witness", () => {
  const sandbox = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-capability-cut-release-lineage-"),
  );
  const source = path.join(sandbox, "source");
  const remote = path.join(sandbox, "remote.git");
  fs.mkdirSync(source);
  runGit(source, ["init", "--initial-branch=main"]);
  runGit(source, ["config", "user.name", "Buildchain Test"]);
  runGit(source, ["config", "user.email", "buildchain@example.invalid"]);
  for (const value of ["base", "cut", "release-tree"]) {
    fs.writeFileSync(path.join(source, "state.txt"), `${value}\n`);
    runGit(source, ["add", "state.txt"]);
    runGit(source, ["commit", "-m", value]);
  }
  const cut = runGit(source, ["rev-parse", "HEAD^"]);
  const protectedHead = runGit(source, ["rev-parse", "HEAD"]);
  runGit(sandbox, ["init", "--bare", remote]);
  runGit(source, ["remote", "add", "origin", remote]);
  runGit(source, ["push", "origin", `${protectedHead}:refs/heads/dev/v4/v4.0`]);

  runGit(source, ["switch", "--orphan", "alpha"]);
  fs.writeFileSync(path.join(source, "state.txt"), "release-tree\n");
  runGit(source, ["add", "state.txt"]);
  runGit(source, ["commit", "-m", "tree-equivalent alpha"]);
  assert.throws(
    () => assertCapabilityCutAncestor({ root: source, revision: cut }),
    /must be an ancestor/u,
  );
  assert.deepEqual(
    ensureCapabilityCutLineage({ root: source, revision: cut }),
    {
      mode: "protected-tree-equivalent",
      witness: protectedHead,
    },
  );

  runGit(source, ["switch", "--orphan", "unrelated-cut"]);
  fs.writeFileSync(path.join(source, "state.txt"), "unrelated-cut\n");
  runGit(source, ["add", "state.txt"]);
  runGit(source, ["commit", "-m", "unrelated cut"]);
  const unrelatedCut = runGit(source, ["rev-parse", "HEAD"]);
  runGit(source, ["switch", "alpha"]);
  assert.throws(
    () => ensureCapabilityCutLineage({ root: source, revision: unrelatedCut }),
    /protected-lineage witness.*must be an ancestor/u,
  );

  fs.writeFileSync(path.join(source, "state.txt"), "drifted-alpha\n");
  runGit(source, ["add", "state.txt"]);
  runGit(source, ["commit", "-m", "drifted alpha"]);
  assert.throws(
    () => ensureCapabilityCutLineage({ root: source, revision: cut }),
    /no tree-equivalent commit in the bounded protected v4 lineage/u,
  );
});

test("live v3 inventory covers every declared category with no unknown or unowned capability", () => {
  const inventory = buildV3V4CapabilityInventory({ root: process.cwd() });
  assert.equal(
    inventory.reverseHistory.fromCommit,
    "6b96bdad8d9f8ccf9275f27d9370a226a9c78465",
  );
  assert.equal(
    inventory.reverseHistory.toCommit,
    "8493bf140a7f567e76aff3119f3d39ff026afc84",
  );
  assert.equal(inventory.reverseHistory.changedPathCount, 87);
  assert.equal(inventory.summary.unknownCount, 0);
  assert.equal(inventory.summary.unownedCount, 0);
  assert.equal(inventory.summary.residualCount, 0);
  assert.ok(
    inventory.capabilities.every(
      (row) => row.positiveProbe && row.negativeProbe,
    ),
  );
});

test("checked-in inventory is structurally valid", () => {
  const inventory = JSON.parse(
    fs.readFileSync(
      "architecture/v3-v4-live-capability-inventory.json",
      "utf8",
    ),
  );
  assert.doesNotThrow(() => assertV3V4CapabilityInventory(inventory));
});

test("unknown, unowned, and nonexistent-route mutations fail closed", () => {
  const inventory = buildV3V4CapabilityInventory({ root: process.cwd() });
  const unknown = structuredClone(inventory);
  unknown.capabilities[0].disposition = "unknown";
  assert.throws(
    () => assertV3V4CapabilityInventory(unknown),
    /disposition is unknown/u,
  );

  const unowned = structuredClone(inventory);
  unowned.capabilities[0].ownerAssignment = "";
  assert.throws(
    () => assertV3V4CapabilityInventory(unowned),
    /owner Assignment is missing/u,
  );

  const routed = structuredClone(inventory);
  const route = routed.capabilities.find(
    (row) => row.disposition !== "owned-missing",
  );
  route.v4Route = null;
  assert.throws(
    () => assertV3V4CapabilityInventory(routed),
    /executable v4 route is missing/u,
  );

  const substituted = structuredClone(inventory);
  const substitutedRoute = substituted.capabilities.find(
    (row) => row.disposition !== "owned-missing",
  );
  substitutedRoute.v4Route.capabilityId =
    "node-export:./nonexistent-substitute";
  assert.throws(
    () => assertV3V4CapabilityInventory(substituted),
    /v4 route identity does not match/u,
  );
});
