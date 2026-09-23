import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yaml } from "yaml";
import * as consumerPlan from "../packages/core/consumer/contract/plan.js";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import { checkWorkflowTaxonomy, workflowPath } from "../packages/core/workflow/workflow-taxonomy.mjs";
import { readConsumerUpgrade } from "../packages/core/consumer/compatibility-workflows.js";

export const SELF_ENTRY_CHANNEL = "v4";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORMS = ["linux-x64", "macos-arm64", "windows-x64"];

// Repository policy checks the consumer-facing wiring. Product implementation
// libraries are separately registered and may not own repository event triggers.
// This policy supplies no repository identity exception to runtime admission.
export function checkSelfConsumerContract(root = ROOT) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const fail = (message) => {
    throw new Error(`self-consumer-contract: ${message}`);
  };
  const plan = consumerPlan.compileConsumerPlan(read(consumerPlan.CONFIG_PATH));
  const retired = path.join(root, ".buildchain/minimal-consumer.toml");
  if (fs.lstatSync(retired, { throwIfNoEntry: false }))
    fail("retired transition config must not remain in the self consumer tree");
  const uses = yaml(read(".github/workflows/buildchain.yml"))?.jobs?.buildchain
    ?.uses;
  const channel =
    typeof uses === "string" && uses.endsWith("@v4-alpha")
      ? "v4-alpha"
      : SELF_ENTRY_CHANNEL;
  const callers = consumerWorkflows(channel);
  for (const [file, bytes] of Object.entries(callers))
    if (read(file) !== bytes) fail(`${file}: generated caller drift`);
  const taxonomy = JSON.parse(read("architecture/workflow-taxonomy.json"));
  const registered = new Set(taxonomy.entries.map(workflowPath));
  const inventory = checkWorkflowTaxonomy(root, { integration: false, documentation: false });
  if (!inventory.ok) fail(inventory.errors.join("; "));
  for (const entry of readConsumerUpgrade(root)?.entries || []) registered.add(entry.path);
  const observed = fs
    .readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => /\.ya?ml$/u.test(file))
    .map((file) => `.github/workflows/${file}`);
  if (
    observed.length !== registered.size ||
    observed.some((file) => !registered.has(file))
  )
    fail("workflow inventory is not closed");
  const self = taxonomy.entries
    .filter((entry) => entry.role === "self")
    .map(workflowPath)
    .sort();
  if (JSON.stringify(self) !== JSON.stringify(Object.keys(callers).sort()))
    fail("self automation must contain exactly the generated caller pair");
  for (const entry of taxonomy.entries.filter(
    (entry) => entry.role !== "self",
  )) {
    const file = workflowPath(entry);
    const document = yaml(read(file));
    if (
      Object.keys(document.on || {}).some(
        (event) => !["workflow_call", "workflow_dispatch"].includes(event),
      )
    )
      fail(`${file}: product library owns a repository event`);
  }
  for (const prefix of ["feature", "fix", "chore", "docs", "ci", "refactor"])
    if (
      !plan.channels.some(
        (route) =>
          route.from === `${prefix}/*` &&
          route.to === "dev/v4/v4.1" &&
          route.operation === "develop",
      )
    )
      fail(`missing protected development route for ${prefix}`);
  for (const platform of PLATFORMS) {
    const verified = plan.products.some(
      (product) =>
        product.platforms.includes(platform) &&
        product.verify.includes("corepack pnpm@11.7.0 run check") &&
        product.verify.includes("node scripts/verify-product-platform.mjs"),
    );
    if (!verified)
      fail(
        `${platform}: full check and platform recovery verification are required`,
      );
  }
  if (
    !plan.products.some(
      (product) =>
        product.type === "npm" &&
        product.targets.some((target) => target.provider === "npm"),
    )
  )
    fail("npm publication is missing");
  for (const platform of PLATFORMS)
    if (
      !plan.products.some(
        (product) =>
          product.type === "binary" &&
          product.platforms.includes(platform) &&
          product.targets.some(
            (target) => target.provider === "github-release",
          ),
      )
    )
      fail(`${platform}: binary release asset is missing`);
  const commands = plan.products.flatMap((product) => [
    ...(product.install || []),
    ...product.build,
    ...product.verify,
  ]);
  if (
    commands.some((command) =>
      /\b(?:npm publish|gh release|buildchain (?:dev warrant|release|promote|recover|publish))\b|request-json|fencingToken/u.test(
        command,
      ),
    )
  )
    fail("product lifecycle contains consumer-owned publication orchestration");
  if (!read(".gitattributes").split("\n").includes("* text=auto eol=lf"))
    fail("cross-platform LF checkout contract is missing");
  return {
    ok: true,
    channel,
    callers: Object.keys(callers),
    plan,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { plan, ...result } = checkSelfConsumerContract();
  console.log(
    JSON.stringify({
      ...result,
      products: plan.products.map((product) => product.id),
    }),
  );
}
