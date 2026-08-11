import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { checkCoreMechanismInventory } from "../scripts/check-core-mechanism-inventory.mjs";

test("v3 core mechanism inventory closes every required evidence dimension", () => {
  const report = checkCoreMechanismInventory();
  assert.equal(report.mechanisms, 12);
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
  inventory.mechanisms[1].sourcePaths.push(
    inventory.mechanisms[0].sourcePaths[0],
  );
  assert.throws(
    () => checkCoreMechanismInventory({ inventory }),
    /ambiguous mechanism ownership/u,
  );
  inventory.mechanisms[1].sourcePaths.pop();
  const settlement = "packages/core/dev-delivery-warrant-settlement.js";
  const deliveryWarrant = inventory.mechanisms.find(
    (mechanism) => mechanism.id === "dev-delivery-warrant",
  );
  deliveryWarrant.sourcePaths = deliveryWarrant.sourcePaths.filter(
    (file) => file !== settlement,
  );
  assert.throws(
    () => checkCoreMechanismInventory({ inventory }),
    /orphan authority coordinate/u,
  );
  deliveryWarrant.sourcePaths.push(settlement);
  deliveryWarrant.testPaths = [];
  assert.throws(
    () => checkCoreMechanismInventory({ inventory }),
    /testPaths is empty/u,
  );
});
