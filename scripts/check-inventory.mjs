import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sharedActionTsupConfig = fs.readFileSync(path.join(root, "scripts/tsup-action.config.mjs"), "utf8");
const commonJsSourcePattern = /\b(require\s*\(|module\.exports|exports\.|require\.main|createRequire)\b/;
const requiredPaths = [
  "README.md",
  "docs/migration-inventory.md",
  "docs/lifecycle-protocol.md",
  "docs/ownership.md",
  "tests/buildchain-inventory.json",
  "buildchain.toml",
  ".github/actionlint.yaml",
  ".github/workflows/self-hosted-runner-smoke.yml",
  ".github/workflows/buildchain-ref-promotion.yml",
  ".github/workflows/verify.yml",
  ".github/workflows/.build.yml",
  ".github/workflows/build-surface-fixture.yml",
  ".github/workflows/candidate-lab.yml",
  "fixtures/libnode-shaped/buildchain.toml",
  "fixtures/libnode-shaped/package.json"
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

if (inventory.release !== "buildchain-v2") {
  throw new Error("inventory release must be buildchain-v2");
}

if (inventory.stableRefs?.actions !== "kungfu-systems/buildchain/actions/<name>@v2") {
  throw new Error("inventory stable action ref must point at @v2");
}

if (inventory.stableRefs?.workflows !== "kungfu-systems/buildchain/.github/workflows/<workflow>.yml@v2") {
  throw new Error("inventory stable workflow ref must point at @v2");
}

if (!Array.isArray(inventory.workflowSources) || inventory.workflowSources.length < 1) {
  throw new Error("workflowSources must include the migrated workflows repository");
}

if (!Array.isArray(inventory.retiredActionsExcluded) || inventory.retiredActionsExcluded.length === 0) {
  throw new Error("retiredActionsExcluded must list retired legacy actions");
}

const actualActions = fs
  .readdirSync(path.join(root, "actions"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(root, "actions", name, "action.yml")))
  .sort();
const internalActions = Array.isArray(inventory.internalActions) ? inventory.internalActions : [];
if (!Array.isArray(inventory.migratedActions) || inventory.migratedActions.length !== 0) {
  throw new Error("migratedActions must be empty; buildchain v2 only ships native actions");
}
const shippedActions = internalActions;
const shippedActionNames = shippedActions.map((action) => action.path.replace(/^actions\//, "")).sort();

if (JSON.stringify(actualActions) !== JSON.stringify(shippedActionNames)) {
  throw new Error(
    `action inventory mismatch. actual=${actualActions.join(",")} inventory=${shippedActionNames.join(",")}`
  );
}

for (const retiredRepo of inventory.retiredActionsExcluded || []) {
  const retiredPath = path.join(root, "actions", retiredRepo.replace(/^action-/, ""));
  if (fs.existsSync(retiredPath)) {
    throw new Error(`retired action must not be shipped in buildchain v2: ${retiredRepo}`);
  }
}

for (const action of shippedActions) {
  for (const key of ["path", "runtime", "build", "bundle"]) {
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
  const tsupConfigPath = path.join(actionPath, "tsup.config.mjs");
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
  const bundleContent = fs.readFileSync(bundlePath, "utf8");
  if (packageJson.type !== "module") {
    throw new Error(`${action.path}/package.json must set type=module`);
  }
  if (!packageJson.scripts?.build?.includes("tsup ")) {
    throw new Error(`${action.path}/package.json must define a tsup build`);
  }
  if (!packageJson.scripts.build.includes("--format esm")) {
    throw new Error(`${action.path}/package.json build must emit ESM`);
  }
  if (!packageJson.scripts.build.includes("tsup-action.config.mjs")) {
    throw new Error(`${action.path}/package.json build must use the shared action tsup config`);
  }
  const tsupConfig = fs.existsSync(tsupConfigPath) ? fs.readFileSync(tsupConfigPath, "utf8") : "";
  if (
    !packageJson.scripts.build.includes("--target node24") &&
    !/target:\s*["']node24["']/.test(tsupConfig) &&
    !/target:\s*["']node24["']/.test(sharedActionTsupConfig)
  ) {
    throw new Error(`${action.path}/package.json build must target node24`);
  }
  if (/(from|import)\s*["']@actions\//.test(bundleContent) || /require\(["']@actions\//.test(bundleContent)) {
    throw new Error(`${action.path}/dist/index.js must bundle @actions dependencies`);
  }
  // Bundled third-party dependencies may still be wrapped with esbuild helper
  // shims. The ESM contract is enforced at the action source and package
  // boundary instead of by banning helper text inside generated bundles.
  const sourceFiles = collectFiles(actionPath, [".js", ".ts", ".mjs"], ["dist"]);
  for (const sourceFile of sourceFiles) {
    const source = fs.readFileSync(sourceFile, "utf8");
    if (commonJsSourcePattern.test(source)) {
      throw new Error(`${path.relative(root, sourceFile)} must use ESM syntax`);
    }
  }
}

for (const file of collectFiles(path.join(root, "packages"), [".cjs"], [])) {
  throw new Error(`CommonJS core package file is not allowed: ${path.relative(root, file)}`);
}

const safety = inventory.safety || {};
for (const key of ["forkPrSecretsDefault", "selfHostedRunnerDefault"]) {
  if (safety[key] !== false) {
    throw new Error(`safety.${key} must be false`);
  }
}
if (safety.trustedEventGate !== true) {
  throw new Error("safety.trustedEventGate must be true");
}
if (safety.reusableContract?.publishGateChannels !== true) {
  throw new Error("safety.reusableContract.publishGateChannels must be true");
}
for (const key of ["publishGateSourceLock", "resolvedReleaseManifest", "packageSetPublishPlan"]) {
  if (safety.reusableContract?.[key] !== true) {
    throw new Error(`safety.reusableContract.${key} must be true`);
  }
}

console.log("buildchain inventory check passed");

function collectFiles(dir, extensions, excludedDirNames) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excludedDirNames.includes(entry.name)) {
      continue;
    }
    const item = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(item, extensions, excludedDirNames));
    } else if (extensions.some((extension) => item.endsWith(extension))) {
      files.push(item);
    }
  }
  return files;
}
