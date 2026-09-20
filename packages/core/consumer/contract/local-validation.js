import fs from "node:fs";
import path from "node:path";
import { consumerWorkflows } from "./entries.js";
import { checkWorkflowTaxonomy } from "../../workflow/workflow-taxonomy.mjs";

export function validateConsumerWiring(cwd, configPath) {
  const expected = consumerWorkflows("v4", configPath);
  const alpha = consumerWorkflows("v4-alpha", configPath);
  const directory = path.join(cwd, ".github/workflows");
  const files = fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true })
    : [];
  if (files.some((file) => file.isSymbolicLink() || file.isDirectory()))
    throw new Error("Consumer workflows must be regular top-level files");
  const names = files
    .filter((file) => /\.ya?ml$/iu.test(file.name))
    .map((file) => `.github/workflows/${file.name}`)
    .sort();
  if (names.some((file) => !Object.hasOwn(expected, file))) {
    const inventory = checkWorkflowTaxonomy(cwd, {
      integration: false,
      documentation: false,
    });
    if (!inventory.ok)
      throw new Error(
        `Invalid workflow implementation inventory: ${inventory.errors.join("; ")}`,
      );
  }
  const callers = Object.keys(expected);
  const actual = Object.fromEntries(
    callers.map((file) => [
      file,
      fs.readFileSync(path.join(cwd, file), "utf8"),
    ]),
  );
  const matches = (templates) =>
    callers.every((file) => templates[file] === actual[file]);
  if (!matches(expected) && !matches(alpha))
    throw new Error(
      "Consumer workflow bytes differ from the shared normal/recovery template or mix channels",
    );
  return { channel: matches(expected) ? "v4" : "v4-alpha", workflows: callers };
}

export function consumerConfigurationSummary(
  loaded,
  versionFiles,
  derivedVersionMaterial,
  requireLifecycleStages,
) {
  const config = loaded.config;
  for (const product of config.products)
    for (const stage of requireLifecycleStages)
      if (!Array.isArray(product[stage]) || !product[stage].length)
        throw new Error(
          `required lifecycle stage missing for product ${product.id}: ${stage}`,
        );
  const lifecycleStages = config.products.flatMap((product) =>
    ["install", "build", "verify"]
      .filter((name) => product[name]?.length)
      .map((name) => ({
        name,
        product: product.id,
        mode: "commands",
        commandCount: product[name].length,
      })),
  );
  return {
    config: { path: loaded.path, filePath: loaded.filePath, schema: 2 },
    products: config.products,
    channels: config.channels,
    review: config.review,
    version: { strategy: config.version.strategy, next: config.version.next },
    versionFiles: versionFiles.map((file) => ({
      path: file.path,
      type: file.type,
      key: file.key,
    })),
    derivedVersionMaterial: derivedVersionMaterial.map((file) => ({
      path: file.path,
    })),
    lifecycleStages,
  };
}
