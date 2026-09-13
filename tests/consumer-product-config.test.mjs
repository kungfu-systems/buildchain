import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverConfiguredVersionStateFiles,
  loadBuildchainConfig,
  updateConfiguredVersionStateContents,
} from "../packages/core/consumer/buildchain-config.js";

function withTempRepo(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-config-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("product tooling reads schema 2 version data without creating a legacy publisher", () => {
  const source = fs.readFileSync(
    "templates/minimal-consumer/npm/.buildchain/buildchain.toml",
    "utf8",
  );
  withTempRepo(
    {
      ".buildchain/buildchain.toml": source,
      "package.json": '{"version":"1.0.0-alpha.1"}\n',
    },
    (dir) => {
      const loaded = loadBuildchainConfig(dir);
      assert.equal(loaded.config.schema, 2);
      assert.equal(loaded.config.lifecycle, undefined);
      assert.equal(loaded.config.publish, undefined);
      assert.equal(loaded.config.products[0].type, "npm");
      const files = discoverConfiguredVersionStateFiles(dir, loaded);
      assert.deepEqual(
        files.map(({ path, type, key }) => ({ path, type, key })),
        [{ path: "package.json", type: "json", key: "version" }],
      );
      assert.equal(
        JSON.parse(
          updateConfiguredVersionStateContents(files, "1.0.0")[0].content,
        ).version,
        "1.0.0",
      );
      fs.appendFileSync(
        path.join(dir, ".buildchain/buildchain.toml"),
        '\n[lifecycle.publish]\ncommand = "npm publish"\n',
      );
      assert.throws(() => loadBuildchainConfig(dir), /unknown field/);
    },
  );
});
