import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { resolveBuildchainConfigPath } from "../../contracts/buildchain-layout.js";
import { compileConsumerPlan } from "./plan.js";

function productConfiguration(source, config) {
  const plan = compileConsumerPlan(source);
  // Read-only version tooling uses the established normalized field names.
  // Product commands remain in the plan; no publish lifecycle is synthesized.
  return {
    ...config,
    version: {
      required: true,
      strategy: plan.version.strategy,
      next: plan.version.strategy === "anchored" ? "manual" : "auto",
      files: plan.version.files.map(({ format, ...file }) => ({
        ...file,
        type: format,
      })),
      derivedFiles: plan.version.derived_files || [],
    },
  };
}

export function readProductConfiguration(cwd, normalizeLegacy) {
  const configPath = resolveBuildchainConfigPath(cwd);
  const filePath = path.join(cwd, configPath);
  if (!fs.existsSync(filePath)) return undefined;
  const source = fs.readFileSync(filePath, "utf8");
  let config;
  try {
    config = parse(source);
  } catch (error) {
    throw new Error(`${configPath} parse failed: ${error.message}`);
  }
  if (![1, 2].includes(config.schema))
    throw new Error(`${configPath} schema must be 1 or 2`);
  return {
    path: configPath,
    filePath,
    config:
      config.schema === 2
        ? productConfiguration(source, config)
        : normalizeLegacy(config),
  };
}
