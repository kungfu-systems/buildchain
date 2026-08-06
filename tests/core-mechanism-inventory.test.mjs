import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { checkCoreMechanismInventory } from "../scripts/check-core-mechanism-inventory.mjs";

test("v3 core mechanism inventory closes every required evidence dimension", () => {
  const report = checkCoreMechanismInventory();
  assert.equal(report.mechanisms, 10);
  assert.equal(report.dependencyCycles, 0);
  assert(report.sourceCoordinates >= 25);
  assert(report.publicSurfaces >= 30);
});

test("orphaned or ambiguously owned mechanism coordinates fail visibly", () => {
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
  inventory.mechanisms[0].testPaths = [];
  assert.throws(
    () => checkCoreMechanismInventory({ inventory }),
    /testPaths is empty/u,
  );
});
