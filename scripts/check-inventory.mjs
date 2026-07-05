import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sharedActionTsupConfig = fs.readFileSync(path.join(root, "scripts/tsup-action.config.mjs"), "utf8");
const commonJsSourcePattern = /\b(require\s*\(|module\.exports|exports\.|require\.main|createRequire)\b/;
const requiredPaths = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "LICENSE-POLICY.md",
  "README.md",
  "SECURITY.md",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
  "bin/buildchain.mjs",
  "docs/MAP.md",
  "docs/binary-distribution.md",
  "docs/cli.md",
  "docs/consumer-issue-reporting.md",
  "docs/install.md",
  "docs/product-mechanism.md",
  "docs/release-passport.md",
  "docs/site-bundle-contract.md",
  "docs/toolkit-observability.md",
  "docs/versioning.md",
  "scripts/release-line-dry-run.mjs",
  "scripts/build-standalone-binary.mjs",
  "scripts/create-release-bundle.mjs",
  "scripts/generate-site-bundle.mjs",
  "scripts/generate-release-candidate-passport.mjs",
  "scripts/npm-publish-dry-run.mjs",
  "scripts/npm-publish-transaction.mjs",
  "scripts/release-candidate-resolver.mjs",
  "scripts/buildchain-patrol.mjs",
  "scripts/workflow-friction-report.mjs",
  "docs/migration-inventory.md",
  "docs/lifecycle-protocol.md",
  "docs/ownership.md",
  "tests/buildchain-inventory.json",
  "buildchain.toml",
  ".github/actionlint.yaml",
  ".github/workflows/self-hosted-runner-smoke.yml",
  ".github/workflows/buildchain-ref-promotion.yml",
  ".github/workflows/dev-pr-auto-merge.yml",
  ".github/workflows/buildchain-patrol.yml",
  ".github/workflows/patrol-daily.yml",
  ".github/workflows/patrol-weekly.yml",
  ".github/workflows/patrol-monthly.yml",
  ".github/workflows/buildchain-patrol-daily.yml",
  ".github/workflows/buildchain-patrol-weekly.yml",
  ".github/workflows/buildchain-patrol-monthly.yml",
  ".github/workflows/release-candidate-promote.yml",
  ".github/workflows/npm-publish.yml",
  ".github/workflows/binary-distribution.yml",
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

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (rootPackage.name !== "@kungfu-tech/buildchain") {
  throw new Error("root package must be @kungfu-tech/buildchain");
}
if (rootPackage.private !== false) {
  throw new Error("root package must be publishable with private=false");
}
if (rootPackage.bin?.buildchain !== "./bin/buildchain.mjs") {
  throw new Error("root package must expose the buildchain CLI");
}
if (rootPackage.exports?.["."] !== "./packages/core/index.js") {
  throw new Error("root package must export packages/core/index.js");
}
if (rootPackage.exports?.["./diagnostics"] !== "./packages/core/diagnostics.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/diagnostics");
}
if (rootPackage.exports?.["./issue-reporting"] !== "./packages/core/issue-reporting.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/issue-reporting");
}
if (rootPackage.exports?.["./logging"] !== "./packages/core/logging.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/logging");
}
if (rootPackage.exports?.["./release-passport"] !== "./packages/core/release-passport.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/release-passport");
}
if (rootPackage.publishConfig?.access !== "public") {
  throw new Error("root package publishConfig.access must be public");
}
if (rootPackage.publishConfig?.registry !== "https://registry.npmjs.org/") {
  throw new Error("root package publishConfig.registry must be npmjs");
}
for (const expectedFile of ["bin/", "scripts/*.mjs", "packages/core/", "docs/MAP.md", "docs/cli.md"]) {
  if (!rootPackage.files?.includes(expectedFile)) {
    throw new Error(`root package files must include ${expectedFile}`);
  }
}
for (const expectedFile of ["dist/site/", "docs/install.md", "docs/binary-distribution.md", "docs/site-bundle-contract.md"]) {
  if (!rootPackage.files?.includes(expectedFile)) {
    throw new Error(`root package files must include ${expectedFile}`);
  }
}
const cliSource = fs.readFileSync(path.join(root, "bin/buildchain.mjs"), "utf8");
const coreIndexSource = fs.readFileSync(path.join(root, "packages/core/index.js"), "utf8");
const versioningDoc = fs.readFileSync(path.join(root, "docs/versioning.md"), "utf8");
const cliDoc = fs.readFileSync(path.join(root, "docs/cli.md"), "utf8");
const installDoc = fs.readFileSync(path.join(root, "docs/install.md"), "utf8");
if (!cliSource.startsWith("#!/usr/bin/env node")) {
  throw new Error("bin/buildchain.mjs must be executable with a node shebang");
}
if (commonJsSourcePattern.test(cliSource)) {
  throw new Error("bin/buildchain.mjs must use ESM syntax");
}
if (!coreIndexSource.includes("verifyBuildchainLogEvents")) {
  throw new Error("packages/core/index.js must export verifyBuildchainLogEvents");
}
if (!coreIndexSource.includes("collectBuildchainDiagnostics")) {
  throw new Error("packages/core/index.js must export collectBuildchainDiagnostics");
}
if (!coreIndexSource.includes("reportBuildchainIssue")) {
  throw new Error("packages/core/index.js must export reportBuildchainIssue");
}
for (const requiredSnippet of [
  "Release passport and binary distribution are a minor surface.",
  "`v2.2`",
  "GitHub-hosted runners for production",
  "Self-hosted runners remain compatibility fixtures",
]) {
  if (!versioningDoc.includes(requiredSnippet)) {
    throw new Error(`versioning doc missing required snippet: ${requiredSnippet}`);
  }
}
for (const [docName, docSource] of Object.entries({ "docs/cli.md": cliDoc, "docs/install.md": installDoc })) {
  for (const requiredSnippet of [
    "minimumReleaseAgeExclude",
    "@kungfu-tech/buildchain@2.2.5",
    "package/version-specific",
  ]) {
    if (!docSource.includes(requiredSnippet)) {
      throw new Error(`${docName} missing fresh Buildchain package pin guidance: ${requiredSnippet}`);
    }
  }
}
const releaseLineDryRunScript = fs.readFileSync(path.join(root, "scripts/release-line-dry-run.mjs"), "utf8");
const standaloneBinaryScript = fs.readFileSync(path.join(root, "scripts/build-standalone-binary.mjs"), "utf8");
for (const requiredSnippet of [
  "explainReleaseLineDryRun",
  "formatReleaseLineDryRun",
  "--target-ref <ref>",
]) {
  if (!releaseLineDryRunScript.includes(requiredSnippet)) {
    throw new Error(`release line dry-run script missing required snippet: ${requiredSnippet}`);
  }
}
if (commonJsSourcePattern.test(releaseLineDryRunScript)) {
  throw new Error("scripts/release-line-dry-run.mjs must use ESM syntax");
}
for (const requiredSnippet of [
  "../packages/core/logging.js",
  "standalone.cli-bundle.create",
  "BUILDCHAIN_EMBEDDED_PACKAGE_VERSION",
  "noExternal: [\"smol-toml\"]",
  "--macho-segment-name",
  "mainFormat: \"commonjs\"",
  "standalone.sea-blob.create",
  "standalone.sea-blob.inject",
  "standalone.archive.create",
  "standalone.build.complete",
  ".log-summary.json",
]) {
  if (!standaloneBinaryScript.includes(requiredSnippet)) {
    throw new Error(`standalone binary script missing observability dogfood snippet: ${requiredSnippet}`);
  }
}
if (commonJsSourcePattern.test(standaloneBinaryScript)) {
  throw new Error("scripts/build-standalone-binary.mjs must use ESM syntax");
}
const npmPublishWorkflow = fs.readFileSync(path.join(root, ".github/workflows/npm-publish.yml"), "utf8");
const buildchainRefPromotionWorkflow = fs.readFileSync(path.join(root, ".github/workflows/buildchain-ref-promotion.yml"), "utf8");
const binaryDistributionWorkflow = fs.readFileSync(path.join(root, ".github/workflows/binary-distribution.yml"), "utf8");
const selfHostedRunnerSmokeWorkflow = fs.readFileSync(path.join(root, ".github/workflows/self-hosted-runner-smoke.yml"), "utf8");
const npmDryRunScript = fs.readFileSync(path.join(root, "scripts/npm-publish-dry-run.mjs"), "utf8");
const npmPublishTransactionScript = fs.readFileSync(path.join(root, "scripts/npm-publish-transaction.mjs"), "utf8");
for (const requiredSnippet of [
  "runs-on: ubuntu-24.04",
  "workflow_dispatch:",
  "Dry-run npm publish",
]) {
  if (!npmPublishWorkflow.includes(requiredSnippet)) {
    throw new Error(`npm publish workflow missing required snippet: ${requiredSnippet}`);
  }
}
for (const forbiddenSnippet of [
  "tags:",
  "Publish exact release tag",
  "npm publish --access public --tag",
]) {
  if (npmPublishWorkflow.includes(forbiddenSnippet)) {
    throw new Error(`npm publish dry-run workflow must not contain real publish snippet: ${forbiddenSnippet}`);
  }
}
for (const requiredSnippet of [
  "id-token: write",
  "actions: read",
  "uses: ./.github/workflows/release-candidate-promote.yml",
  "target-sha: ${{ github.event.workflow_run.head_sha || inputs.sha || github.sha }}",
  "publish-required-artifacts-json: \"[]\"",
]) {
  if (!buildchainRefPromotionWorkflow.includes(requiredSnippet)) {
    throw new Error(`buildchain ref promotion workflow missing npm transaction snippet: ${requiredSnippet}`);
  }
}
for (const forbiddenSnippet of [
  "run: node scripts/release-candidate-resolver.mjs",
  "uses: ./actions/promote-buildchain-ref",
]) {
  if (buildchainRefPromotionWorkflow.includes(forbiddenSnippet)) {
    throw new Error(`buildchain ref promotion workflow must use the declarative wrapper, found manual snippet: ${forbiddenSnippet}`);
  }
}
for (const requiredSnippet of [
  "distTag || (pkg.version.includes(\"-\") ? \"alpha\" : \"latest\")",
  "\"publish\", \"--dry-run\", \"--access\", \"public\"",
  "expectedTag && expectedTag !== exactTag",
]) {
  if (!npmDryRunScript.includes(requiredSnippet)) {
    throw new Error(`npm publish dry-run script missing required snippet: ${requiredSnippet}`);
  }
}
if (commonJsSourcePattern.test(npmDryRunScript)) {
  throw new Error("scripts/npm-publish-dry-run.mjs must use ESM syntax");
}
for (const requiredSnippet of [
  "BUILDCHAIN_PUBLISH_EVIDENCE",
  "\"publish\", \"--access\", access, \"--tag\", distTag",
  "artifact digest mismatch",
]) {
  if (!npmPublishTransactionScript.includes(requiredSnippet)) {
    throw new Error(`npm publish transaction script missing required snippet: ${requiredSnippet}`);
  }
}
if (commonJsSourcePattern.test(npmPublishTransactionScript)) {
  throw new Error("scripts/npm-publish-transaction.mjs must use ESM syntax");
}
if (/runs-on:\s*self-hosted/.test(npmPublishWorkflow)) {
  throw new Error("npm publish workflow must use GitHub-hosted runners for trusted publishing");
}
for (const requiredSnippet of [
  "name: Binary Distribution",
  "ubuntu-24.04",
  "macos-latest",
  "windows-2022",
  "BUILDCHAIN_LOG_PATH",
  "buildchain-log-events",
  "buildchain-log-summary",
  "bin/buildchain.mjs mark",
  "bin/buildchain.mjs span",
  "verify observability-log",
  "bin/buildchain.mjs log summary",
  "collect github-release",
  "verify release-passport",
  "scripts/create-release-bundle.mjs",
  "buildchain-release-bundle",
  "gh release upload",
]) {
  if (!binaryDistributionWorkflow.includes(requiredSnippet)) {
    throw new Error(`binary distribution workflow missing required snippet: ${requiredSnippet}`);
  }
}
if (/runs-on:\s*self-hosted/.test(binaryDistributionWorkflow)) {
  throw new Error("binary distribution production workflow must not require self-hosted runners");
}
if (!selfHostedRunnerSmokeWorkflow.includes("BUILDCHAIN_RUNNER_KIND: self-hosted")) {
  throw new Error("self-hosted smoke must remain a release-passport compatibility fixture");
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
if (inventory.safety?.releasePassport?.line !== "v2.2") {
  throw new Error("release passport inventory must be registered as a v2.2 surface");
}
if (inventory.safety?.releasePassport?.binaryDistribution?.productionRunnerDefault !== "github-hosted") {
  throw new Error("release passport binary distribution must default to GitHub-hosted production runners");
}
if (inventory.safety?.releasePassport?.binaryDistribution?.selfHostedRole !== "compatibility-fixture") {
  throw new Error("self-hosted runners must remain release passport compatibility fixtures");
}
for (const artifact of [
  "buildchain.release.json",
  "artifact-evidence.json",
  "impact.json",
  "agent-index.json",
  "check-report.json",
  "llms.txt",
  "buildchain-release-bundle.json",
  "buildchain-release-bundle.tar.gz",
]) {
  if (!inventory.safety?.releasePassport?.protocolArtifacts?.includes(artifact)) {
    throw new Error(`release passport inventory missing protocol artifact ${artifact}`);
  }
}

for (const siteFile of ["buildchain-site.json", "site-manifest.json", "cli-registry.json", "release-model.json"]) {
  if (!fs.existsSync(path.join(root, "dist", "site", siteFile))) {
    throw new Error(`site bundle missing ${siteFile}`);
  }
}

if (!Array.isArray(inventory.workflowSources) || inventory.workflowSources.length < 1) {
  throw new Error("workflowSources must include the migrated workflows repository");
}

if (!Array.isArray(inventory.retiredActionsExcluded) || inventory.retiredActionsExcluded.length === 0) {
  throw new Error("retiredActionsExcluded must list retired legacy actions");
}
if (!Array.isArray(inventory.retiredWorkflowsExcluded) || inventory.retiredWorkflowsExcluded.length === 0) {
  throw new Error("retiredWorkflowsExcluded must list retired legacy workflows");
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

for (const retiredWorkflow of inventory.retiredWorkflowsExcluded || []) {
  const retiredPath = path.join(root, retiredWorkflow);
  if (fs.existsSync(retiredPath)) {
    throw new Error(`retired workflow must not be shipped in buildchain v2: ${retiredWorkflow}`);
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
if (safety.npmPublish?.promotionTransaction !== true) {
  throw new Error("safety.npmPublish.promotionTransaction must be true");
}
if (safety.npmPublish?.tagPushPublish !== false) {
  throw new Error("safety.npmPublish.tagPushPublish must be false");
}
if (safety.npmPublish?.exactVersionsOnly !== true) {
  throw new Error("safety.npmPublish.exactVersionsOnly must be true");
}
if (safety.npmPublish?.alphaDistTag !== "alpha") {
  throw new Error("safety.npmPublish.alphaDistTag must be alpha");
}
if (safety.npmPublish?.stableDistTag !== "latest") {
  throw new Error("safety.npmPublish.stableDistTag must be latest");
}
if (safety.npmPublish?.trustedPublishing !== true) {
  throw new Error("safety.npmPublish.trustedPublishing must be true");
}
if (safety.npmPublish?.manualDryRun !== true) {
  throw new Error("safety.npmPublish.manualDryRun must be true");
}
if (safety.npmPublish?.manualDryRunPublishes !== false) {
  throw new Error("safety.npmPublish.manualDryRunPublishes must be false");
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
