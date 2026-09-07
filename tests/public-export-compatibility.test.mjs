import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url)),
);
const policy = JSON.parse(
  fs.readFileSync(
    new URL("../architecture/implementation-naming.json", import.meta.url),
  ),
);

test("published generation aliases resolve to the same responsibility implementations", async () => {
  for (const [specifier, names] of Object.entries(policy.publishedAliases)) {
    const api = await import(
      new URL(`../${manifest.exports[specifier]}`, import.meta.url)
    );
    for (const old of names) {
      assert.ok(Object.hasOwn(api, old), `${specifier}: ${old} was removed`);
      assert.equal(
        api[old],
        api[policy.symbolMigrations[old]],
        `${specifier}: ${old} forks its implementation`,
      );
    }
  }
});
