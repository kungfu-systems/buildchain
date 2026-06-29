import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const requiredPaths = [
  "README.md",
  "docs/migration-inventory.md",
  "docs/ownership.md",
  "tests/buildchain-inventory.json",
  ".github/workflows/verify.yml",
  ".github/workflows/candidate-lab.yml",
  "fixtures/action-bump-version-smoke/README.md",
  "actions/bump-version/README.md"
];

for (const rel of requiredPaths) {
  if (!fs.existsSync(path.join(root, rel))) {
    throw new Error(`missing required path: ${rel}`);
  }
}

const inventory = JSON.parse(
  fs.readFileSync(path.join(root, "tests/buildchain-inventory.json"), "utf8")
);

if (inventory.schemaVersion !== 1) {
  throw new Error("inventory schemaVersion must be 1");
}

if (!Array.isArray(inventory.coreSelfBootstrap) || inventory.coreSelfBootstrap.length < 2) {
  throw new Error("coreSelfBootstrap must include workflows and action-bump-version");
}

const coreRepos = new Set(inventory.coreSelfBootstrap.map((entry) => entry.repo));
for (const repo of ["workflows", "action-bump-version"]) {
  if (!coreRepos.has(repo)) {
    throw new Error(`coreSelfBootstrap is missing ${repo}`);
  }
}

if (!Array.isArray(inventory.activeCoupledActions) || inventory.activeCoupledActions.length < 7) {
  throw new Error("activeCoupledActions must include the initial active migration set");
}

const safety = inventory.phase1Safety || {};
for (const key of [
  "publishingDefault",
  "consumerChangesDefault",
  "forkPrSecretsDefault",
  "selfHostedRunnerDefault"
]) {
  if (safety[key] !== false) {
    throw new Error(`phase1Safety.${key} must be false`);
  }
}

console.log("buildchain inventory check passed");

