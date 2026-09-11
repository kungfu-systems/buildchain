import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const contract = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture/universal-workflow-bootstrap.json"),
    "utf8",
  ),
);

test("bootstrap and direct capability APIs partition all reusable workflows", () => {
  const declared = [
    ...contract.directCapabilityWorkflows,
    ...contract.bootstrapGovernedWorkflows,
  ];
  assert.equal(new Set(declared).size, declared.length);
  assert.deepEqual(declared.sort(), contract.inventoryWorkflows);
  const actual = fs
    .readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => /\.yml$/u.test(file))
    .map((file) => `.github/workflows/${file}`)
    .filter((file) =>
      /^\s*workflow_call:/mu.test(
        fs.readFileSync(path.join(root, file), "utf8"),
      ),
    )
    .sort();
  assert.deepEqual(contract.inventoryWorkflows, actual);
});

test("direct workflows do not carry alternate historical execution branches", () => {
  assert.equal(Object.hasOwn(contract, "migration"), false);
  for (const file of contract.directCapabilityWorkflows) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, file), "utf8"),
      /universal-request-json|universal-bootstrap:/u,
      file,
    );
  }
  for (const file of [
    "scripts/generate-universal-workflow-facades.mjs",
    "scripts/universal-facade-maintainability.mjs",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});
