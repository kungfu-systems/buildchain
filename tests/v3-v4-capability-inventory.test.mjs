import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertV3V4CapabilityInventory,
  buildV3V4CapabilityInventory,
} from "../scripts/check-v3-v4-capability-inventory.mjs";

test("live v3 inventory covers every declared category with no unknown or unowned capability", () => {
  const inventory = buildV3V4CapabilityInventory({ root: process.cwd() });
  assert.equal(
    inventory.reverseHistory.fromCommit,
    "6b96bdad8d9f8ccf9275f27d9370a226a9c78465",
  );
  assert.equal(
    inventory.reverseHistory.toCommit,
    "88d089b9c69dd08be00f120d623447ae881f1374",
  );
  assert.equal(inventory.reverseHistory.changedPathCount, 82);
  assert.equal(inventory.summary.unknownCount, 0);
  assert.equal(inventory.summary.unownedCount, 0);
  assert.ok(inventory.summary.residualCount > 0);
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
