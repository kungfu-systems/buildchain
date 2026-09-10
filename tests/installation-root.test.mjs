import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { installationRoot } from "../packages/core/runtime/installation-root.js";

test("runtime resources stay bound to the executing distribution across source and nested action bundles", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-installation-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries({
    "package.json": JSON.stringify({ name: "@kungfu-tech/buildchain" }),
    "bin/buildchain.mjs": "",
    "architecture/code-layout.json": "{}",
    "packages/core/build/commands/run.mjs": "",
    "actions/build/lifecycle/run/package.json": JSON.stringify({
      name: "@kungfu-systems/internal-action",
    }),
    "actions/build/lifecycle/run/dist/index.js": "",
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  for (const file of [
    "packages/core/build/commands/run.mjs",
    "actions/build/lifecycle/run/dist/index.js",
  ])
    assert.equal(
      installationRoot(pathToFileURL(path.join(root, file))),
      fs.realpathSync(root),
    );
  fs.unlinkSync(path.join(root, "bin/buildchain.mjs"));
  assert.throws(
    () =>
      installationRoot(
        pathToFileURL(
          path.join(root, "actions/build/lifecycle/run/dist/index.js"),
        ),
      ),
    /missing its CLI/,
  );
});

test("a detached bundle cannot borrow runtime resources from the consumer workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-detached-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, "index.js");
  fs.writeFileSync(entry, "");
  assert.throws(
    () => installationRoot(pathToFileURL(entry)),
    /outside a Buildchain distribution/,
  );
});
