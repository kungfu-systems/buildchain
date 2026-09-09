import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSourceBindings } from "../scripts/check-source-bindings.mjs";

test("source binding check catches missing names inside deferred and uncommon branches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-bindings-"));
  try {
    fs.writeFileSync(
      path.join(root, "entry.mjs"),
      "export function run(options) { if (options.recover) return missingRecovery(options); return { propertyOnly: true }; }\n",
    );
    const result = checkSourceBindings({ root, files: ["entry.mjs"] });
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0].message, /missingRecovery/);
    fs.writeFileSync(
      path.join(root, "entry.mjs"),
      "const recover = value => value; export function run(options) { return recover({ propertyOnly: options.now }); }\n",
    );
    assert.deepEqual(
      checkSourceBindings({ root, files: ["entry.mjs"] }).issues,
      [],
    );
    fs.writeFileSync(
      path.join(root, "dependency.mjs"),
      "export const owned = 1;\n",
    );
    fs.writeFileSync(
      path.join(root, "entry.mjs"),
      'import { retired } from "./dependency.mjs"; export const value = retired;\n',
    );
    const missingExport = checkSourceBindings({
      root,
      files: ["entry.mjs", "dependency.mjs"],
    });
    assert.equal(missingExport.issues.length, 1);
    assert.match(missingExport.issues[0].message, /retired/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
