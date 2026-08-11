import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  architectureList,
  architectureShow,
  compareNMinusOne,
  loadArchitecture,
  validateManifest,
} from "../scripts/v4-architecture.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("v4 architecture contract validates with zero production writer migrations", () => {
  const { report } = loadArchitecture(root);
  assert.deepEqual(report, {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-architecture-validation",
    ok: true,
    releaseLine: "dev/v4/v4.0",
    capabilities: 12,
    stateMachines: 6,
    dependencyLayers: 6,
    dependencyCycles: 0,
    activeExceptions: 0,
    productionWriterMigrations: 0,
  });
});

test("architecture list and show are generated from the validated manifest", () => {
  const list = architectureList(root);
  assert.equal(list.capabilities.length, 12);
  assert.equal(
    list.capabilities.find(
      (entry) => entry.id === "release-tail-provider-plane",
    ).stateMachine,
    true,
  );
  assert.equal(
    list.capabilities.find((entry) => entry.id === "publish-transaction")
      .stateMachine,
    true,
  );
  assert.equal(
    list.capabilities.find((entry) => entry.id === "engineering-housekeeper")
      .stateMachine,
    false,
  );
  assert.equal(
    architectureShow("engineering-housekeeper", root).capability.migrationPhase,
    "legacy-authoritative",
  );
  const shown = architectureShow("publish-transaction", root);
  assert.equal(
    shown.capability.owner,
    "Buildchain package and release publication plane",
  );
  assert.equal(shown.stateMachines[0].writer.runtime, "typescript-v3");
  assert.equal(shown.stateMachines[0].writer.secondWriterBudget, 0);
  assert.throws(
    () => architectureShow("missing", root),
    /unknown architecture capability/,
  );
});

test("validation rejects cycles, a second writer, and missing recovery", () => {
  const source = loadArchitecture(root);
  const cyclic = structuredClone(source.manifest);
  cyclic.dependencyLayers[0].mayDependOn = ["workflows"];
  assert.throws(
    () =>
      validateManifest({
        manifest: cyclic,
        inventory: JSON.parse(
          fs.readFileSync(
            path.join(root, "architecture/v3-core-mechanism-inventory.json"),
            "utf8",
          ),
        ),
        bootstrap: source.bootstrap,
        ledger: source.ledger,
      }),
    /dependency layer cycle/,
  );

  const secondWriter = structuredClone(source.manifest);
  secondWriter.stateMachines[0].writer.secondWriterBudget = 1;
  secondWriter.stateMachines[0].recovery = [];
  assert.throws(
    () =>
      validateManifest({
        manifest: secondWriter,
        inventory: JSON.parse(
          fs.readFileSync(
            path.join(root, "architecture/v3-core-mechanism-inventory.json"),
            "utf8",
          ),
        ),
        bootstrap: source.bootstrap,
        ledger: source.ledger,
      }),
    /recovery must be a non-empty array.*zero second-writer budget/s,
  );
});

function commit(rootPath, message) {
  execFileSync("git", ["add", "architecture"], { cwd: rootPath });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: rootPath });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootPath,
    encoding: "utf8",
  }).trim();
}

test("N-1 qualification rejects self authority and candidate ceiling widening", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-n-minus-one-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporaryRoot, "architecture"));
  execFileSync("git", ["init", "-q"], { cwd: temporaryRoot });
  execFileSync("git", ["config", "user.name", "Buildchain Test"], {
    cwd: temporaryRoot,
  });
  execFileSync("git", ["config", "user.email", "test@buildchain.invalid"], {
    cwd: temporaryRoot,
  });
  for (const relativePath of [
    "architecture/v4-capability-state-machine-manifest.json",
    "architecture/v4-exception-ledger.json",
  ]) {
    fs.copyFileSync(
      path.join(root, relativePath),
      path.join(temporaryRoot, relativePath),
    );
  }
  const authority = commit(temporaryRoot, "authority");
  assert.throws(
    () =>
      compareNMinusOne({
        root: temporaryRoot,
        authorityRevision: authority,
        candidateRevision: authority,
      }),
    /rejects candidate self-qualification/,
  );

  const manifestPath = path.join(
    temporaryRoot,
    "architecture/v4-capability-state-machine-manifest.json",
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.budgets.agentCognitive.hardCeilings.requiredDiscoveryCommands = 1;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const tightened = commit(temporaryRoot, "tighten");
  const result = compareNMinusOne({
    root: temporaryRoot,
    authorityRevision: authority,
    candidateRevision: tightened,
  });
  assert.equal(result.ok, true);
  assert.equal(result.frozenManifestFields, 4);
  assert.equal(
    result.budgetDeltas.find(
      (entry) =>
        entry.dimension === "agentCognitive" &&
        entry.name === "requiredDiscoveryCommands",
    ).direction,
    "tightened",
  );

  manifest.capabilities[0].owner = "candidate-owned authority";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const drifted = commit(temporaryRoot, "drift owner");
  assert.throws(
    () =>
      compareNMinusOne({
        root: temporaryRoot,
        authorityRevision: tightened,
        candidateRevision: drifted,
      }),
    /candidate drifted from N-1 manifest authority: capabilities/,
  );

  manifest.capabilities[0].owner = "Buildchain Dev delivery control plane";
  manifest.budgets.agentCognitive.hardCeilings.requiredDiscoveryCommands = 3;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const widened = commit(temporaryRoot, "widen");
  assert.throws(
    () =>
      compareNMinusOne({
        root: temporaryRoot,
        authorityRevision: tightened,
        candidateRevision: widened,
      }),
    /candidate widened N-1 ceiling/,
  );
});
