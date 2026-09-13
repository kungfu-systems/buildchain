import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectKfdUpstreamFacts } from "../packages/core/adoption/kfd.js";
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

test("product upstream evidence survives the minimal consumer configuration", () => {
  const components = JSON.parse(fs.readFileSync("architecture/product-upstreams.json", "utf8"));
  const before = collectKfdUpstreamFacts({ cwd: process.cwd(), components, includeOwn: false });
  assert.equal(before.summary.upstreamCount, 1);
  assert.equal(before.upstreams[0].package.name, "@kungfu-tech/kfd");
  assert.equal(before.upstreams[0].assets.length, 7);
  withTempRepo(
    {
      ".buildchain/buildchain.toml": fs.readFileSync("templates/minimal-consumer/npm/.buildchain/buildchain.toml", "utf8"),
      "package.json": fs.readFileSync("package.json", "utf8"),
    },
    (cwd) => {
      fs.symlinkSync(path.resolve("node_modules"), path.join(cwd, "node_modules"), "junction");
      assert.equal(collectKfdUpstreamFacts({ cwd, includeOwn: false }).summary.upstreamCount, 0);
      const after = collectKfdUpstreamFacts({ cwd, components, includeOwn: false });
      assert.deepEqual(after, before);
    },
  );
});
