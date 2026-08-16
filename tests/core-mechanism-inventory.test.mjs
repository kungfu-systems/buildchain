import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { checkCoreMechanismInventory } from "../scripts/check-core-mechanism-inventory.mjs";

test("v3 core mechanism inventory closes every required evidence dimension", () => {
  const report = checkCoreMechanismInventory();
  assert.equal(report.mechanisms, 13);
  assert.equal(report.dependencyCycles, 0);
  assert(report.sourceCoordinates >= 55);
  assert(report.authorityCoordinates >= 41);
  assert(report.publicSurfaces >= 45);
  assert.deepEqual(report.surfaceKinds, [
    "action",
    "cli",
    "export",
    "workflow",
  ]);
  assert.equal(report.gitRefStores, 3);
});

test("reverse-discovered orphaned or ambiguously owned mechanism coordinates fail visibly", () => {
  const inventory = JSON.parse(
    fs.readFileSync("architecture/v3-core-mechanism-inventory.json", "utf8"),
  );
  const devDelivery = inventory.mechanisms.find(
    ({ id }) => id === "dev-delivery-warrant",
  );
  const releaseCandidate = inventory.mechanisms.find(
    ({ id }) => id === "release-candidate-passport",
  );
  releaseCandidate.sourcePaths.push(devDelivery.sourcePaths[0]);
  assert.throws(
    () => checkCoreMechanismInventory({ inventory }),
    /ambiguous mechanism ownership/u,
  );
  releaseCandidate.sourcePaths.pop();
  const settlement = "packages/core/dev-delivery-warrant-settlement.js";
  devDelivery.sourcePaths = devDelivery.sourcePaths.filter(
    (file) => file !== settlement,
  );
  assert.throws(
    () => checkCoreMechanismInventory({ inventory }),
    /orphan authority coordinate/u,
  );
  devDelivery.sourcePaths.push(settlement);
  devDelivery.testPaths = [];
  assert.throws(
    () => checkCoreMechanismInventory({ inventory }),
    /testPaths is empty/u,
  );
});
