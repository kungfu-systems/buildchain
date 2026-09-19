import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import { finalizeBuildchainContractWorld } from "../packages/core/contracts/buildchain-contract.js";
import { materializePipelineVersion } from "../packages/core/publication/pipeline/version.js";
import {
  collectPipelineVersionMaterial,
  pipelineVersionMaterialPaths,
  pipelineVersionRegenerationResult,
} from "../packages/core/publication/pipeline/version-regeneration.js";

test("self version policy admits regenerated contract digests for development and stable versions", () => {
  const configPath = ".buildchain/minimal-consumer.toml";
  const { version: versionPolicy } = compileConsumerPlan(
    fs.readFileSync(configPath, "utf8"),
  );
  const files = Object.fromEntries(
    pipelineVersionMaterialPaths(versionPolicy, configPath).map((file) => [
      file,
      fs.readFileSync(file, "utf8"),
    ]),
  );
  const contractPath = "dist/site/buildchain-contract.json";
  const contract = JSON.parse(files[contractPath]);
  const [major, minor, patch] = contract.product.version
    .split("-")[0]
    .split(".");
  const stable = `${major}.${minor}.${Number(patch) + 1}`;
  for (const version of [`${stable}-alpha.999`, stable]) {
    const preparation = {
      root: `sha256:${"a".repeat(64)}`,
      source: { configPath },
      versionPolicy,
      version,
      platforms: ["linux-x64", "macos-arm64", "windows-x64"],
    };
    const planned = materializePipelineVersion(versionPolicy, files, version);
    const regenerated = finalizeBuildchainContractWorld({
      ...contract,
      product: { ...contract.product, version },
    });
    assert.notEqual(regenerated.contractDigest, contract.contractDigest);
    assert.equal(regenerated.compatibilityDigest, contract.compatibilityDigest);
    const observed = {
      ...files,
      ...Object.fromEntries(
        planned.changes.map(({ path, content }) => [path, content]),
      ),
      [contractPath]: `${JSON.stringify(regenerated, null, 2)}\n`,
    };
    const material = collectPipelineVersionMaterial(
      preparation,
      files,
      preparation.platforms.map((platform) =>
        pipelineVersionRegenerationResult(preparation, platform, observed),
      ),
    );
    assert.equal(
      material.changes.find(({ path }) => path === contractPath).content,
      observed[contractPath],
    );
  }
});
