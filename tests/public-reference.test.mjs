import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { BUILDCHAIN_COMMAND_REGISTRY } from "../bin/internal/command-registry.mjs";
import { BUILDCHAIN_USAGE } from "../scripts/buildchain-cli-help.mjs";
import {
  createCliReference,
  createNodeApiReference,
  formatCliHelp,
} from "../scripts/public-reference.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

test("governed CLI reference covers runtime commands and nested side-effect-free help", () => {
  const reference = createCliReference(BUILDCHAIN_USAGE);
  const topLevel = new Set(reference.map((entry) => entry.path[0]));
  assert.deepEqual(
    [...topLevel].sort(),
    BUILDCHAIN_COMMAND_REGISTRY.map((entry) => entry.id).sort(),
  );
  assert.match(
    formatCliHelp({ usageText: BUILDCHAIN_USAGE, pathParts: ["kfd", "3"] }),
    /buildchain kfd 3 detect/,
  );
  assert.match(
    formatCliHelp({ usageText: BUILDCHAIN_USAGE, pathParts: ["publication"] }),
    /publication-artifact/,
  );

  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-help-contract-"),
  );
  try {
    for (const entry of reference) {
      const result = spawnSync(
        process.execPath,
        [bin, ...entry.path, "--help"],
        {
          cwd,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, `${entry.helpCommand}: ${result.stderr}`);
      assert.match(result.stdout, /Help is read-only|Usage:/);
    }
    assert.deepEqual(
      fs.readdirSync(cwd),
      [],
      "CLI help created consumer files",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Node API reference closes package exports over exact runtime symbols", async () => {
  const reference = createNodeApiReference({ root, packageJson });
  const expectedTargets = Object.entries(packageJson.exports).filter(
    ([specifier, target]) =>
      !specifier.startsWith("./site/") &&
      specifier !== "./package.json" &&
      typeof target === "string" &&
      target.endsWith(".js"),
  );
  assert.equal(reference.length, expectedTargets.length);
  for (const surface of reference) {
    const namespace = await import(
      pathToFileURL(path.join(root, surface.target)).href
    );
    assert.deepEqual(
      surface.symbols.map((entry) => entry.name).sort(),
      Object.keys(namespace).sort(),
      surface.specifier,
    );
    for (const symbol of surface.symbols) {
      assert.ok(
        symbol.signature,
        `${surface.specifier}#${symbol.name} signature`,
      );
      assert.ok(
        Array.isArray(symbol.parameters),
        `${surface.specifier}#${symbol.name} parameters`,
      );
      assert.ok(symbol.returns, `${surface.specifier}#${symbol.name} return`);
      assert.ok(
        symbol.errors.length > 0,
        `${surface.specifier}#${symbol.name} errors`,
      );
      assert.ok(
        symbol.sideEffects.length > 0,
        `${surface.specifier}#${symbol.name} side effects`,
      );
      assert.match(symbol.example, /^import \{ .+ \} from /);
      assert.ok(
        fs.existsSync(path.join(root, symbol.source.path)),
        `${surface.specifier}#${symbol.name} source`,
      );
    }
  }
});
