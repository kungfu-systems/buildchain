import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectActionTaxonomy } from "../packages/core/contracts/action-taxonomy.js";
import { actionInventory } from "../packages/core/contracts/action-inventory.js";

test("action ownership catalog covers every executable directory exactly once", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const catalog = JSON.parse(
    fs.readFileSync(
      new URL("../architecture/action-taxonomy.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(inspectActionTaxonomy(actionInventory(root), catalog), []);
});

test("unregistered wrappers, stale declarations and duplicate operations fail closed", () => {
  const actions = [{ directory: "actions/build/source/admit" }];
  const catalog = {
    schema: "buildchain.action-taxonomy/v1",
    domains: {
      build: {
        groups: {
          source: {
            responsibility: "Admit the exact source before business execution.",
            operations: ["admit"],
          },
        },
      },
    },
  };
  assert.deepEqual(inspectActionTaxonomy(actions, catalog), []);
  assert.match(
    inspectActionTaxonomy(
      [...actions, { directory: "actions/build/source/step12" }],
      catalog,
    ).join("\n"),
    /undeclared action responsibility/,
  );
  assert.match(
    inspectActionTaxonomy([], catalog).join("\n"),
    /declared action is missing/,
  );
  catalog.domains.build.groups.source.operations.push("admit");
  assert.match(
    inspectActionTaxonomy(actions, catalog).join("\n"),
    /duplicate action operation/,
  );
});
