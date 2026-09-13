import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bindConsumerSource } from "../../consumer/contract/identity.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
import { createNativeChildEnvironment } from "../../dev-delivery/native/execution.js";

function sourceCheckout(cwd, expected) {
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }).trim();
  if (
    git("rev-parse", "HEAD") !== expected.commit ||
    git("rev-parse", "HEAD^{tree}") !== expected.tree
  )
    throw new Error("Build checkout does not match admitted source");
  const configFile = fs.realpathSync(path.join(cwd, expected.configPath));
  if (!configFile.startsWith(`${fs.realpathSync(cwd)}${path.sep}`))
    throw new Error("Consumer TOML escapes the source checkout");
  const { identity, plan } = bindConsumerSource(
    {
      repository: expected.repository,
      commit: expected.commit,
      tree: expected.tree,
      configPath: expected.configPath,
      configBlob: git("rev-parse", `HEAD:${expected.configPath}`),
    },
    fs.readFileSync(configFile),
  );
  if (recordDigest(identity) !== recordDigest(expected))
    throw new Error("Build TOML changed after source admission");
  if (git("status", "--porcelain", "--untracked-files=no"))
    throw new Error(
      "Build source has tracked modifications at its verification boundary",
    );
  return plan;
}

function productDirectory(cwd, product) {
  const directory = fs.realpathSync(
    path.resolve(cwd, product.directory || "."),
  );
  const root = fs.realpathSync(cwd);
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`))
    throw new Error("Product directory escapes its source checkout");
  return directory;
}

// This node executes only product-owned build/test commands, on a read-only
// credential job. Its output is an observation; independent seal/qualification
// jobs must bind provider completion and exact artifacts before granting reuse.
export async function buildPipelineSource(
  { cwd, source, platform, environment = process.env },
  { inspect = sourceCheckout, session = consumerCommandSession } = {},
) {
  const plan = inspect(cwd, source);
  const result = await buildPipelineProducts(
    { cwd, plan, platform, environment },
    session,
  );
  inspect(cwd, source);
  return {
    schema: "buildchain.pipeline-build-observation/v1",
    source,
    ...result,
  };
}

export async function buildPipelineProducts(
  { cwd, plan, platform, environment = process.env },
  session = consumerCommandSession,
) {
  const products = plan.products.filter((product) =>
    product.platforms.includes(platform),
  );
  if (!products.length)
    throw new Error("No products declared for the selected platform");
  const results = [];
  for (const product of products) {
    const commands = session(createNativeChildEnvironment(environment));
    const directory = productDirectory(cwd, product);
    for (const phase of ["install", "build", "verify"]) {
      for (const script of product[phase] || [])
        await commands.run({ script, cwd: directory, strict: true });
    }
    results.push({ product: product.id, outcome: "success" });
  }
  return {
    platform,
    products: results,
  };
}
