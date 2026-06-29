import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const requiredPaths = [
  "README.md",
  "docs/migration-inventory.md",
  "docs/ownership.md",
  "tests/buildchain-inventory.json",
  ".github/actionlint.yaml",
  ".github/workflows/agent-120-smoke.yml",
  ".github/workflows/verify.yml",
  ".github/workflows/candidate-lab.yml",
  "fixtures/action-bump-version-smoke/README.md"
];

for (const rel of requiredPaths) {
  if (!fs.existsSync(path.join(root, rel))) {
    throw new Error(`missing required path: ${rel}`);
  }
}

const inventory = JSON.parse(
  fs.readFileSync(path.join(root, "tests/buildchain-inventory.json"), "utf8")
);

if (inventory.schemaVersion !== 2) {
  throw new Error("inventory schemaVersion must be 2");
}

if (inventory.release !== "buildchain-v1") {
  throw new Error("inventory release must be buildchain-v1");
}

if (!Array.isArray(inventory.workflowSources) || inventory.workflowSources.length < 1) {
  throw new Error("workflowSources must include the migrated workflows repository");
}

if (!Array.isArray(inventory.migratedActions) || inventory.migratedActions.length === 0) {
  throw new Error("migratedActions must include buildchain v1 actions");
}

const actualActions = fs
  .readdirSync(path.join(root, "actions"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(root, "actions", name, "action.yml")))
  .sort();
const inventoriedActions = inventory.migratedActions.map((action) => action.path.replace(/^actions\//, "")).sort();

if (JSON.stringify(actualActions) !== JSON.stringify(inventoriedActions)) {
  throw new Error(
    `migratedActions mismatch. actual=${actualActions.join(",")} inventory=${inventoriedActions.join(",")}`
  );
}

for (const retiredRepo of inventory.retiredActionsExcluded || []) {
  const retiredPath = path.join(root, "actions", retiredRepo.replace(/^action-/, ""));
  if (fs.existsSync(retiredPath)) {
    throw new Error(`retired action must not be shipped in buildchain v1: ${retiredRepo}`);
  }
}

for (const action of inventory.migratedActions) {
  for (const key of ["path", "previousRepo", "runtime", "build", "bundle"]) {
    if (!action[key]) {
      throw new Error(`migrated action entry is missing ${key}`);
    }
  }
  if (action.runtime !== "node24") {
    throw new Error(`${action.path} must use node24`);
  }
  if (action.build !== "tsup") {
    throw new Error(`${action.path} must build with tsup`);
  }
  const actionPath = path.join(root, action.path);
  const actionYmlPath = path.join(actionPath, "action.yml");
  const packageJsonPath = path.join(actionPath, "package.json");
  const bundlePath = path.join(root, action.bundle);
  for (const required of [actionYmlPath, packageJsonPath, bundlePath, path.join(actionPath, "README.md")]) {
    if (!fs.existsSync(required)) {
      throw new Error(`missing action artifact: ${path.relative(root, required)}`);
    }
  }
  const actionYml = fs.readFileSync(actionYmlPath, "utf8");
  if (!/using:\s*["']node24["']/.test(actionYml)) {
    throw new Error(`${action.path}/action.yml must use node24`);
  }
  if (!/main:\s*["']dist\/index\.js["']/.test(actionYml)) {
    throw new Error(`${action.path}/action.yml must point at dist/index.js`);
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (!packageJson.scripts?.build?.includes("tsup ")) {
    throw new Error(`${action.path}/package.json must define a tsup build`);
  }
  if (!packageJson.scripts.build.includes("--target node24")) {
    throw new Error(`${action.path}/package.json build must target node24`);
  }
}

const safety = inventory.safety || {};
for (const key of ["forkPrSecretsDefault", "selfHostedRunnerDefault"]) {
  if (safety[key] !== false) {
    throw new Error(`safety.${key} must be false`);
  }
}

console.log("buildchain inventory check passed");
