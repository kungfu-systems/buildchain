import fs from "node:fs";
import path from "node:path";
import {
  assertPublicSurfaceReverseAudit,
  collectPublicSurfaceReverseAudit,
} from "../packages/core/public-surface-audit.js";
import { evaluateBuildchainContractLock } from "../packages/core/buildchain-contract.js";
import {
  canAdmitSelfDogfoodLockEvaluation,
  contractForSelfDogfoodEvaluation,
  resolveSelfDogfoodMajor,
} from "../packages/core/self-dogfood-version.js";
import { generateChannelBuildWorkflow } from "./generate-channel-build-workflow.mjs";
import {
  generateChannelPromotionWorkflow,
  parsePromotionShellRouting,
} from "./generate-channel-promotion-workflow.mjs";
import { assertPublicReferenceRegistry } from "./site-reference-registry.mjs";
const root = process.cwd();
const sharedActionTsupConfig = fs.readFileSync(path.join(root, "scripts/tsup-action.config.mjs"), "utf8");
const commonJsSourcePattern = /\b(require\s*\(|module\.exports|exports\.|require\.main|createRequire)\b/;
function assertSelfReleaseImpactContract(impact, { expectedVersion = "" } = {}) {
  if (!impact || typeof impact !== "object" || Array.isArray(impact)) {
    throw new Error("Buildchain self release impact must be a JSON object");
  }
  const version = String(impact.release?.version || "").trim();
  const versionMatch = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!versionMatch) throw new Error("Buildchain self release impact release.version must be a semantic version");
  if (expectedVersion && version !== expectedVersion) {
    throw new Error("Buildchain self release impact version must match package.json version");
  }
  const expectedLine = `v${versionMatch[1]}.${versionMatch[2]}`;
  const line = String(impact.release?.line || "").trim();
  if (line !== expectedLine) {
    throw new Error(`Buildchain self release impact line must be ${expectedLine} for release.version ${version}`);
  }
  const summary = String(impact.summary || "").trim();
  if (!summary.startsWith(`Buildchain ${line} `)) {
    throw new Error(`Buildchain self release impact summary must describe the current ${line} line`);
  }
}

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
  "packages/core/homebrew.js",
  "packages/core/artifact-verification-envelope.js",
  "packages/core/anchored-version-material.js",
  "packages/core/build-facts.js",
  "packages/core/publication-package.js",
  "packages/core/publication-reproducibility.js",
  "packages/core/publication-sealed-bundle.js",
  "packages/core/paper.js",
  "packages/core/release-line-bootstrap.js",
  "packages/core/public-surface-audit.js",
  "docs/MAP.md",
  "docs/build-facts.md",
  "docs/binary-distribution.md",
  "docs/cli.md",
  "docs/consumer-issue-reporting.md",
  "docs/homebrew.md",
  "docs/install.md",
  "docs/product-mechanism.md",
  "docs/readme-badges.md",
  "docs/release-passport.md",
  "docs/github-artifact-attestation.md",
  "docs/shifu-gate-profiles.md",
  "docs/auditable-demo.md",
  "contracts/auditable-demo-scenario-v1.schema.json",
  "contracts/release-candidate-recovery-v1.schema.json",
  "contracts/auditable-demo-media-profiles-v1.json",
  "contracts/evidence/auditable-demo-web-delivery-v1.json",
  "contracts/evidence/auditable-demo-responsive-web-delivery-v1.json",
  "contracts/buildchain-v2-residuals-v1.json",
  "contracts/fixtures/auditable-demo-web-delivery-v1/complete-transcript.txt",
  "contracts/fixtures/auditable-demo-web-delivery-v1/public-projection.json",
  "contracts/fixtures/auditable-demo-web-delivery-v1/scene.json",
  "contracts/fixtures/auditable-demo-responsive-web-delivery-v1/complete-transcript.txt",
  "contracts/fixtures/auditable-demo-responsive-web-delivery-v1/public-projection.json",
  "contracts/fixtures/auditable-demo-responsive-web-delivery-v1/scene.json",
  "docs/release-propagation.md",
  "docs/site-bundle-contract.md",
  "docs/toolkit-observability.md",
  "docs/versioning.md",
  "scripts/release-line-dry-run.mjs",
  "scripts/reconcile-release-governance.mjs",
  "scripts/buildchain-channel-router.mjs",
  "scripts/generate-channel-build-workflow.mjs",
  "scripts/promotion-channel-router.mjs",
  "scripts/promotion-identity-resolver.mjs",
  "scripts/generate-channel-promotion-workflow.mjs",
  "scripts/build-standalone-binary.mjs",
  "scripts/create-release-bundle.mjs",
  "scripts/ensure-github-release.mjs",
  "scripts/generate-site-bundle.mjs",
  "scripts/generate-buildchain-kfd-witnesses.mjs",
  "scripts/generate-release-candidate-passport.mjs",
  "scripts/seal-macos-credential-input.mjs",
  "scripts/shifu-gate-profile.mjs",
  "scripts/auditable-demo.mjs",
  "scripts/auditable-demo-platform.mjs",
  "scripts/auditable-demo-transport-smoke.mjs",
  "scripts/auditable-demo-capture.py",
  "scripts/resolve-artifact-coordinates.mjs",
  "scripts/artifact-relay-s3.mjs",
  "scripts/anchored-version-material.mjs",
  "scripts/npm-publish-dry-run.mjs",
  "scripts/npm-publish-transaction.mjs",
  "scripts/paper.mjs",
  "scripts/publication-package.mjs",
  "scripts/publication-commit-evidence.mjs",
  "scripts/publication-reproducibility.mjs",
  "scripts/release-candidate-resolver.mjs",
  "scripts/resume-from-candidate-run.mjs",
  "scripts/buildchain-patrol.mjs",
  "scripts/observed-evidence.mjs",
  "scripts/workflow-friction-report.mjs",
  "scripts/web-surface-production-release-pr.mjs",
  "docs/migration-inventory.md",
  "docs/lifecycle-protocol.md",
  "docs/observed-evidence-patrol.md",
  "docs/ownership.md",
  "tests/buildchain-inventory.json",
  "tests/paper.test.mjs",
  ".buildchain/buildchain.toml",
  ".buildchain/contract-lock.json",
  ".buildchain/alpha-contract-lock.json",
  ".buildchain/release-impact.json",
  ".github/actionlint.yaml",
  ".github/workflows/self-hosted-runner-smoke.yml",
  ".github/workflows/buildchain-ref-promotion.yml",
  ".github/workflows/buildchain-candidate-recovery-dogfood-failure.yml",
  ".github/workflows/release-line-bootstrap.yml",
  ".github/workflows/release-governance-reconcile.yml",
  ".github/workflows/dev-pr-auto-merge.yml",
  ".github/workflows/buildchain-dev-delivery.yml",
  ".github/workflows/buildchain-patrol.yml",
  ".github/workflows/patrol-daily.yml",
  ".github/workflows/patrol-weekly.yml",
  ".github/workflows/patrol-monthly.yml",
  ".github/workflows/patrol-observed-evidence.yml",
  ".github/workflows/buildchain-patrol-daily.yml",
  ".github/workflows/buildchain-patrol-weekly.yml",
  ".github/workflows/buildchain-patrol-monthly.yml",
  ".github/workflows/buildchain-alpha-self-dogfood.yml",
  ".github/workflows/release-candidate-promote.yml",
  ".github/workflows/.release-candidate-promote.yml",
  ".github/workflows/release-propagation.yml",
  ".github/workflows/npm-publish.yml",
  ".github/workflows/paper-release.yml",
  ".github/workflows/binary-distribution.yml",
  ".github/workflows/.binary-release-assets.yml",
  ".github/workflows/binary-release-assets.yml",
  ".github/workflows/verify.yml",
  ".github/workflows/.build.yml",
  ".github/workflows/.gate-profile.yml",
  ".github/workflows/.auditable-demo.yml",
  ".github/workflows/.declarative-auditable-demo.yml",
  ".github/workflows/auditable-demo.yml",
  ".github/workflows/build.yml",
  ".github/workflows/build-surface-fixture.yml",
  ".github/workflows/candidate-lab.yml",
  "fixtures/libnode-shaped/buildchain.toml",
  "fixtures/libnode-shaped/.github/workflows/build.yml",
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
const selfDogfoodWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/buildchain-alpha-self-dogfood.yml"),
  "utf8",
);
const selfDogfoodAlphaLock = JSON.parse(
  fs.readFileSync(path.join(root, ".buildchain/alpha-contract-lock.json"), "utf8"),
);
const currentBuildchainContract = JSON.parse(
  fs.readFileSync(path.join(root, "dist/site/buildchain-contract.json"), "utf8"),
);
const selfDogfoodMajorResolution = resolveSelfDogfoodMajor({
  packageVersion: rootPackage.version,
  alphaRef: selfDogfoodAlphaLock.buildchain?.ref,
  majorBootstrap: process.env.BUILDCHAIN_MAJOR_VERSION_BOOTSTRAP === "true",
});
const selfDogfoodMajor = String(selfDogfoodMajorResolution.workflowMajor);
if (!/^[0-9a-f]{40}$/.test(selfDogfoodAlphaLock.buildchain?.resolvedSha || "")) {
  throw new Error("Buildchain self-dogfood alpha lock must record an exact accepted SHA");
}
if (selfDogfoodAlphaLock.buildchain?.compatibilityPolicy !== "major-compatible") {
  throw new Error("Buildchain self-dogfood alpha lock must enforce major-compatible policy");
}
const selfDogfoodAlphaEvaluation = evaluateBuildchainContractLock({
  lock: selfDogfoodAlphaLock,
  current: contractForSelfDogfoodEvaluation({
    currentContract: currentBuildchainContract,
    majorResolution: selfDogfoodMajorResolution,
  }),
  runtimeRef: `v${selfDogfoodMajor}-alpha`,
  runtimeSha: "current-development-contract",
  runtimeClass: "alpha",
});
if (
  !canAdmitSelfDogfoodLockEvaluation({
    evaluation: selfDogfoodAlphaEvaluation,
    majorResolution: selfDogfoodMajorResolution,
  })
) {
  throw new Error("Buildchain self-dogfood alpha lock requires review after a breaking contract change");
}
for (const requiredSnippet of [
  `/.github/workflows/build.yml@v${selfDogfoodMajor}-alpha`,
  "buildchain-channel: auto",
  "buildchain-channel: stable",
  `const alphaRef = "v${selfDogfoodMajor}-alpha"`,
  `const stableRef = "v${selfDogfoodMajor}"`,
]) {
  if (!selfDogfoodWorkflow.includes(requiredSnippet)) {
    throw new Error(`Buildchain self-dogfood workflow missing current-major snippet: ${requiredSnippet}`);
  }
}
const reusableBuildWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/.build.yml"),
  "utf8",
);
for (const requiredSnippet of [
  "BUILDCHAIN_WORKFLOW_REF: ${{ job.workflow_ref }}",
  "process.env.BUILDCHAIN_WORKFLOW_REF || process.env.GITHUB_WORKFLOW_REF",
  'replace(/^refs\\/(?:heads|tags)\\//, "")',
]) {
  if (!reusableBuildWorkflow.includes(requiredSnippet)) {
    throw new Error(`reusable build workflow missing called-workflow identity: ${requiredSnippet}`);
  }
}
const channelBuildWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/build.yml"),
  "utf8",
);
if (channelBuildWorkflow !== generateChannelBuildWorkflow(reusableBuildWorkflow)) {
  throw new Error("generated channel build workflow is stale");
}
const advancedPromotionWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/.release-candidate-promote.yml"),
  "utf8",
);
const channelPromotionWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/release-candidate-promote.yml"),
  "utf8",
);
const promotionShellRouting = parsePromotionShellRouting(
  fs.readFileSync(path.join(root, ".buildchain/promotion-shell-routing.json"), "utf8"),
  { major: Number(selfDogfoodMajor) },
);
if (channelPromotionWorkflow !== generateChannelPromotionWorkflow(advancedPromotionWorkflow, {
  major: Number(selfDogfoodMajor),
  shellRouting: promotionShellRouting,
})) {
  throw new Error("generated channel promotion workflow is stale");
}
for (const requiredSnippet of [
  "buildchain-channel:",
  `/${promotionShellRouting.alpha.workflowPath}@${promotionShellRouting.alpha.callRef}`,
  `/${promotionShellRouting.stable.workflowPath}@${promotionShellRouting.stable.callRef}`,
  `STABLE_SHELL_REF: v${selfDogfoodMajor}`,
  "promotion-contract-lock-digest:",
  "authorize-promotion-runtime-override.cjs",
  "BUILDCHAIN_ROUTER_REPOSITORY: ${{ inputs.buildchain-repository }}",
  "BUILDCHAIN_RESUME_RUNTIME_SHA: ${{ inputs.resume-buildchain-runtime-sha }}",
  "if [[ \"${ref}\" =~ ^[0-9A-Fa-f]{40}$ ]]; then", "sha=\"${ref,,}\"", "git ls-remote",
  "Recovery router ref does not match resume-buildchain-runtime-sha",
]) {
  if (!channelPromotionWorkflow.includes(requiredSnippet)) {
    throw new Error(`channel promotion workflow missing routing contract: ${requiredSnippet}`);
  }
}
for (const forbiddenSnippet of ["job.workflow_repository", "job.workflow_sha"]) {
  if (channelPromotionWorkflow.includes(forbiddenSnippet)) {
    throw new Error(`channel promotion workflow uses unsupported GitHub context: ${forbiddenSnippet}`);
  }
}
const promotionOverrideAuthorization = fs.readFileSync(
  path.join(root, "scripts/authorize-promotion-runtime-override.cjs"),
  "utf8",
);
if (!promotionOverrideAuthorization.includes("promotion runtime override is only allowed for trusted workflow_dispatch runs")) {
  throw new Error("promotion runtime override authorization must remain fail closed");
}
for (const requiredSnippet of [
  "buildchain-channel:",
  "uses: ./.github/workflows/.build.yml",
  "needs.resolve-channel.outputs.buildchain-ref",
  "needs.resolve-channel.outputs.contract-lock-path",
]) {
  if (!channelBuildWorkflow.includes(requiredSnippet)) {
    throw new Error(`channel build workflow missing routing contract: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "group: buildchain-release-promotion-${{ github.repository }}",
  "cancel-in-progress: false",
]) {
  if (!selfDogfoodWorkflow.includes(requiredSnippet)) {
    throw new Error(`Buildchain self-dogfood workflow missing promotion serialization: ${requiredSnippet}`);
  }
}
const actionlintConfig = fs.readFileSync(
  path.join(root, ".github/actionlint.yaml"),
  "utf8",
);
for (const requiredSnippet of [
  ".github/workflows/build.yml:",
  ".github/workflows/.build.yml:",
  ".github/workflows/.gate-profile.yml:",
  'property "workflow_ref" is not defined in object type',
  'property "workflow_repository" is not defined in object type',
  'property "workflow_sha" is not defined in object type',
]) {
  if (!actionlintConfig.includes(requiredSnippet)) {
    throw new Error(`actionlint config missing scoped job.workflow_ref compatibility rule: ${requiredSnippet}`);
  }
}
const packageDependencySections = ["dependencies", "optionalDependencies", "peerDependencies"];
const exoticDependencyPattern =
  /^(?:git(?:\+ssh|\+https|\+http|\+file)?:|github:|gitlab:|bitbucket:|https?:|file:|link:|workspace:)/i;
for (const sectionName of packageDependencySections) {
  const section = rootPackage[sectionName] || {};
  for (const [dependencyName, specifier] of Object.entries(section)) {
    if (typeof specifier !== "string") {
      throw new Error(`package ${sectionName}.${dependencyName} must use a string version specifier`);
    }
    if (exoticDependencyPattern.test(specifier.trim())) {
      throw new Error(
        `package ${sectionName}.${dependencyName} must use an auditable npm registry version, not exotic specifier: ${specifier}`,
      );
    }
  }
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
if (rootPackage.exports?.["./homebrew"] !== "./packages/core/homebrew.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/homebrew");
}
if (rootPackage.exports?.["./buildchain-contract"] !== "./packages/core/buildchain-contract.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/buildchain-contract");
}
if (rootPackage.exports?.["./controller-evidence"] !== "./packages/core/controller-evidence.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/controller-evidence");
}
if (rootPackage.exports?.["./artifact-verification-envelope"] !== "./packages/core/artifact-verification-envelope.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/artifact-verification-envelope");
}
if (rootPackage.exports?.["./issue-reporting"] !== "./packages/core/issue-reporting.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/issue-reporting");
}
if (rootPackage.exports?.["./kfd"] !== "./packages/core/kfd.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/kfd");
}
if (rootPackage.exports?.["./release-line-bootstrap"] !== "./packages/core/release-line-bootstrap.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/release-line-bootstrap");
}
if (rootPackage.exports?.["./readme-badges"] !== "./packages/core/readme-badges.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/readme-badges");
}
if (rootPackage.exports?.["./badges"] !== "./packages/core/badges.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/badges");
}
if (rootPackage.exports?.["./build-facts"] !== "./packages/core/build-facts.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/build-facts");
}
if (rootPackage.exports?.["./logging"] !== "./packages/core/logging.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/logging");
}
if (rootPackage.exports?.["./kfd-gate"] !== "./packages/core/kfd-gate.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/kfd-gate");
}
if (rootPackage.exports?.["./release-passport"] !== "./packages/core/release-passport.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/release-passport");
}
if (rootPackage.exports?.["./github-artifact-attestation"] !== "./packages/core/github-artifact-attestation.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/github-artifact-attestation");
}
if (rootPackage.exports?.["./release-passport-contract"] !== "./packages/core/release-passport-contract.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/release-passport-contract");
}
if (rootPackage.exports?.["./release-propagation"] !== "./packages/core/release-propagation.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/release-propagation");
}
if (rootPackage.exports?.["./surface-manifest"] !== "./packages/core/surface-manifest.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/surface-manifest");
}
if (rootPackage.exports?.["./buildchain-kfd-claims"] !== "./packages/core/buildchain-kfd-claims.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/buildchain-kfd-claims");
}
if (rootPackage.exports?.["./public-surface-audit"] !== "./packages/core/public-surface-audit.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/public-surface-audit");
}
if (rootPackage.exports?.["./paper"] !== "./packages/core/paper.js") {
  throw new Error("root package must export @kungfu-tech/buildchain/paper");
}
if (rootPackage.exports?.["./site/buildchain-site.json"] !== "./dist/site/buildchain-site.json") {
  throw new Error("root package must export @kungfu-tech/buildchain/site/buildchain-site.json");
}
if (rootPackage.exports?.["./site/site-manifest.json"] !== "./dist/site/site-manifest.json") {
  throw new Error("root package must export @kungfu-tech/buildchain/site/site-manifest.json");
}
if (rootPackage.exports?.["./site/page-registry.json"] !== "./dist/site/page-registry.json") {
  throw new Error("root package must export @kungfu-tech/buildchain/site/page-registry.json");
}
if (rootPackage.exports?.["./site/capability-registry.json"] !== "./dist/site/capability-registry.json") {
  throw new Error("root package must export @kungfu-tech/buildchain/site/capability-registry.json");
}
if (rootPackage.exports?.["./site/manual-registry.json"] !== "./dist/site/manual-registry.json") {
  throw new Error("root package must export @kungfu-tech/buildchain/site/manual-registry.json");
}
if (rootPackage.exports?.["./site/node-api-registry.json"] !== "./dist/site/node-api-registry.json") {
  throw new Error("root package must export @kungfu-tech/buildchain/site/node-api-registry.json");
}
if (rootPackage.exports?.["./site/kfd-claims.json"] !== "./dist/site/kfd-claims.json") {
  throw new Error("root package must export @kungfu-tech/buildchain/site/kfd-claims.json");
}
if (rootPackage.exports?.["./site/public-surface-audit.json"] !== "./dist/site/public-surface-audit.json") {
  throw new Error("root package must export @kungfu-tech/buildchain/site/public-surface-audit.json");
}
if (rootPackage.publishConfig?.access !== "public") {
  throw new Error("root package publishConfig.access must be public");
}
if (rootPackage.publishConfig?.registry !== "https://registry.npmjs.org/") {
  throw new Error("root package publishConfig.registry must be npmjs");
}
for (const expectedFile of ["bin/", "scripts/*.mjs", "packages/core/", "docs/*.md"]) {
  if (!rootPackage.files?.includes(expectedFile)) {
    throw new Error(`root package files must include ${expectedFile}`);
  }
}
for (const expectedFile of ["dist/site/", "actions/*/README.md", "fixtures/*/README.md"]) {
  if (!rootPackage.files?.includes(expectedFile)) {
    throw new Error(`root package files must include ${expectedFile}`);
  }
}
const cliSource = fs.readFileSync(path.join(root, "bin/buildchain.mjs"), "utf8");
const coreIndexSource = fs.readFileSync(path.join(root, "packages/core/index.js"), "utf8");
const versioningDoc = fs.readFileSync(path.join(root, "docs/versioning.md"), "utf8");
const cliDoc = fs.readFileSync(path.join(root, "docs/cli.md"), "utf8");
const docsMap = fs.readFileSync(path.join(root, "docs/MAP.md"), "utf8");
const installDoc = fs.readFileSync(path.join(root, "docs/install.md"), "utf8");
const siteBundle = JSON.parse(fs.readFileSync(path.join(root, "dist/site/buildchain-site.json"), "utf8"));
const siteManifest = JSON.parse(fs.readFileSync(path.join(root, "dist/site/site-manifest.json"), "utf8"));
const pageRegistry = JSON.parse(fs.readFileSync(path.join(root, "dist/site/page-registry.json"), "utf8"));
const capabilityRegistry = JSON.parse(fs.readFileSync(path.join(root, "dist/site/capability-registry.json"), "utf8"));
const badgeEndpointRegistry = JSON.parse(fs.readFileSync(path.join(root, "dist/site/badge-endpoint-registry.json"), "utf8"));
const publicSurfaceAudit = JSON.parse(fs.readFileSync(path.join(root, "dist/site/public-surface-audit.json"), "utf8"));
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
if (!coreIndexSource.includes("createBuildchainContractWorld")) {
  throw new Error("packages/core/index.js must export Buildchain contract lock APIs");
}
if (!coreIndexSource.includes("KFD2_RELEASE_TRUST_PASSPORT_CONTRACT")) {
  throw new Error("packages/core/index.js must export KFD-2 release trust passport contract");
}
if (!coreIndexSource.includes("KFD2_TRUST_PROOF_CONTRACT")) {
  throw new Error("packages/core/index.js must export KFD-2 trust proof contract");
}
if (!coreIndexSource.includes("createSurfaceTimestampPolicy")) {
  throw new Error("packages/core/index.js must export surface manifest timestamp policy APIs");
}
for (const requiredSnippet of [
  "collectModuleBuildFacts",
  "aggregateBuildFacts",
  "verifyBuildFacts",
  "writeKungfuBuildInfoProjection",
]) {
  if (!coreIndexSource.includes(requiredSnippet)) {
    throw new Error(`packages/core/index.js must export Build Facts API: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "detectKfd3Surfaces",
  "registerKfd3Surfaces",
  "auditKfd3Surfaces",
  "createKfd3SurfaceWitness",
  "queryKfd3Capabilities",
]) {
  if (!coreIndexSource.includes(requiredSnippet)) {
    throw new Error(`packages/core/index.js must export KFD-3 surface API: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "collectBadgeBundleFacts",
  "renderBadgeBundleBlock",
  "checkBadgeBundleBlock",
  "updateBadgeBundleBlock",
  "collectReadmeBadgeFacts",
  "renderReadmeBadgeBlock",
  "checkReadmeBadgeBlock",
  "updateReadmeBadgeBlock",
  "createKfdBadgeSpecsFromStandards",
  "createReadmeBadgeEndpointRegistry",
]) {
  if (!coreIndexSource.includes(requiredSnippet)) {
    throw new Error(`packages/core/index.js must export README badge API: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "collectHomebrewTapFacts",
  "renderHomebrewFormula",
  "checkHomebrewTap",
  "updateHomebrewTap",
]) {
  if (!coreIndexSource.includes(requiredSnippet)) {
    throw new Error(`packages/core/index.js must export Homebrew API: ${requiredSnippet}`);
  }
}
if (siteBundle.contract !== "kungfu-buildchain-site-bundle") {
  throw new Error("buildchain-site.json must expose the Buildchain site bundle contract");
}
if (siteBundle.package?.version !== rootPackage.version) {
  throw new Error("buildchain-site.json package.version must match package.json version");
}
if (siteManifest.package?.version !== rootPackage.version) {
  throw new Error("site-manifest.json package.version must match package.json version");
}
const publicationRegistry = JSON.parse(fs.readFileSync(path.join(root, "dist/site/publication-registry.json"), "utf8"));
if (publicationRegistry.package?.version !== rootPackage.version) {
  throw new Error("publication-registry.json package.version must match package.json version");
}
if (siteBundle.source?.homepageTextSource !== "README.md") {
  throw new Error("buildchain-site.json source.homepageTextSource must be README.md");
}
if (siteManifest.source?.homepageTextSource !== "README.md") {
  throw new Error("site-manifest.json source.homepageTextSource must be README.md");
}
if (siteBundle.homepage?.title !== "Buildchain") {
  throw new Error("buildchain-site.json homepage.title must match README H1");
}
if (!Array.isArray(siteBundle.homepage?.sections) || siteBundle.homepage.sections.length < 5) {
  throw new Error("buildchain-site.json homepage.sections must expose README-derived sections");
}
for (const requiredSection of ["install-and-verify", "use-buildchain", "release-model", "toolkit-observability", "site-fact-source"]) {
  if (!siteBundle.homepage.sections.some((entry) => entry.id === requiredSection && entry.sourcePath === "README.md" && entry.markdown)) {
    throw new Error(`buildchain-site.json homepage.sections must include README projection ${requiredSection}`);
  }
}
if (siteBundle.homepage.sections.some((entry) => entry.id === "homepage-content-contract")) {
  throw new Error("buildchain-site.json homepage.sections must not render the renderer contract as homepage content");
}
if (
  siteBundle.homepage?.rendererContract?.id !== "homepage-content-contract" ||
  siteBundle.homepage?.rendererContract?.renderAsHomepageContent !== false ||
  !siteBundle.homepage?.rendererContract?.markdown
) {
  throw new Error("buildchain-site.json homepage.rendererContract must expose README renderer contract outside homepage.sections");
}
if (!siteBundle.homepage?.displayPlan?.firstScreen?.include?.includes("install-and-verify")) {
  throw new Error("buildchain-site.json homepage.displayPlan firstScreen must include install-and-verify");
}
if (!Array.isArray(siteBundle.renderingBoundary?.ownedByBuildchain) || !siteBundle.renderingBoundary.ownedByBuildchain.includes("homepage section projection from README.md")) {
  throw new Error("buildchain-site.json renderingBoundary.ownedByBuildchain must include README projection ownership");
}
if (!Array.isArray(siteBundle.renderingBoundary?.ownedBySite) || !siteBundle.renderingBoundary.ownedBySite.includes("markdown-to-HTML renderer")) {
  throw new Error("buildchain-site.json renderingBoundary.ownedBySite must include markdown-to-HTML renderer");
}
if (pageRegistry.contract !== "kungfu-buildchain-site-page-registry") {
  throw new Error("page-registry.json must expose the site page registry contract");
}
if (siteBundle.pageRegistry?.path !== "page-registry.json" || siteBundle.pageRegistry?.pageCount !== pageRegistry.pageCount) {
  throw new Error("buildchain-site.json must link to page-registry.json with matching page count");
}
if (capabilityRegistry.contract !== "kungfu-buildchain-capability-registry") {
  throw new Error("capability-registry.json must expose the Buildchain capability registry contract");
}
if (siteBundle.capabilityRegistry?.path !== "capability-registry.json" || siteBundle.capabilityRegistry?.groupCount !== capabilityRegistry.groups?.length) {
  throw new Error("buildchain-site.json must link to capability-registry.json with matching group count");
}
if (!siteManifest.facts?.includes("capability-registry.json") || !siteBundle.entrypoints?.includes("capability-registry.json")) {
  throw new Error("site bundle entrypoints must include capability-registry.json");
}
if (!siteManifest.facts?.includes("page-registry.json") || !siteBundle.entrypoints?.includes("page-registry.json")) {
  throw new Error("site bundle entrypoints must include page-registry.json");
}
if (!siteManifest.facts?.includes("public-surface-audit.json") || !siteBundle.entrypoints?.includes("public-surface-audit.json")) {
  throw new Error("site bundle entrypoints must include public-surface-audit.json");
}
if (publicSurfaceAudit.contract !== "kungfu-buildchain-public-surface-reverse-audit") {
  throw new Error("public-surface-audit.json must expose the reverse audit contract");
}
assertPublicSurfaceReverseAudit(publicSurfaceAudit);
const livePublicSurfaceAudit = collectPublicSurfaceReverseAudit({ root });
assertPublicSurfaceReverseAudit(livePublicSurfaceAudit);
if (JSON.stringify(publicSurfaceAudit.summary) !== JSON.stringify(livePublicSurfaceAudit.summary)) {
  throw new Error("public-surface-audit.json summary is stale; run pnpm run generate:site");
}
for (const [name, manifest] of [["buildchain-site.json", siteBundle], ["site-manifest.json", siteManifest]]) {
  if (!manifest.generatedAt) {
    throw new Error(`${name} must expose generatedAt`);
  }
  if (manifest.timestampPolicy === "ci-injected" && manifest.generatedAt === "1970-01-01T00:00:00.000Z") {
    throw new Error(`${name} must not use epoch generatedAt when timestampPolicy=ci-injected`);
  }
  if (!manifest.timestampPolicy || !manifest.reproducible || !Array.isArray(manifest.deterministicInputs)) {
    throw new Error(`${name} must expose the Buildchain surface timestamp/reproducibility policy`);
  }
  if (manifest.timestampPolicyDetails?.contract !== "kungfu-buildchain-surface-timestamp-policy") {
    throw new Error(`${name} must expose timestampPolicyDetails.contract`);
  }
}
function immediateReadmes(dir) {
  const absoluteDir = path.join(root, dir);
  if (!fs.existsSync(absoluteDir)) return [];
  return fs.readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}/README.md`)
    .filter((relPath) => fs.existsSync(path.join(root, relPath)))
    .sort();
}
const expectedPageSources = [
  "README.md",
  ...fs.readdirSync(path.join(root, "docs")).filter((name) => name.endsWith(".md")).sort().map((name) => `docs/${name}`),
  ...immediateReadmes("actions"),
  "packages/core/README.md",
  ...immediateReadmes("fixtures"),
].sort();
const registryPageSources = [...new Set((pageRegistry.pages || []).map((page) => page.sourcePath))].sort();
const bundlePageSources = [...new Set((siteBundle.pages || []).map((page) => page.sourcePath))].sort();
if (JSON.stringify(registryPageSources) !== JSON.stringify(expectedPageSources)) {
  throw new Error(`page-registry.json must include every public markdown page: expected ${expectedPageSources.length}, got ${registryPageSources.length}`);
}
if (JSON.stringify(bundlePageSources) !== JSON.stringify(expectedPageSources)) {
  throw new Error(`buildchain-site.json pages must include every public markdown page: expected ${expectedPageSources.length}, got ${bundlePageSources.length}`);
}
for (const page of pageRegistry.pages || []) {
  if (!page.id || !page.route || !page.title || !page.category || !page.capabilityGroup || !Array.isArray(page.audience) || !page.maturity || !page.sourcePath || !page.digest || !page.markdown) {
    throw new Error(`page-registry.json page is incomplete: ${page.sourcePath || page.id || "<unknown>"}`);
  }
}
const capabilityGroupIds = new Set((capabilityRegistry.groups || []).map((group) => group.id));
if (capabilityGroupIds.size < 6) {
  throw new Error("capability-registry.json must expose grouped Buildchain capabilities");
}
for (const page of pageRegistry.pages || []) {
  if (!capabilityGroupIds.has(page.capabilityGroup)) {
    throw new Error(`page-registry.json page references unknown capability group: ${page.sourcePath || page.id}`);
  }
}
const manualRegistry = JSON.parse(fs.readFileSync(path.join(root, "dist/site/manual-registry.json"), "utf8"));
for (const manual of manualRegistry.manuals || []) {
  if (!manual.capabilityGroup || !capabilityGroupIds.has(manual.capabilityGroup) || !Array.isArray(manual.audience) || !manual.maturity || typeof manual.order !== "number") {
    throw new Error(`manual-registry.json manual missing capability metadata: ${manual.path || manual.id}`);
  }
}
const cliRegistry = JSON.parse(fs.readFileSync(path.join(root, "dist/site/cli-registry.json"), "utf8"));
const requiredPublicLifecycleFields = [
  "owner",
  "maturity",
  "introducedVersion",
  "compatibilityPromise",
  "deprecationReplacement",
  "sunsetCondition",
  "capabilityGroup",
  "nonDuplicationRationale",
];
function assertPublicLifecycle(entry, label) {
  for (const field of requiredPublicLifecycleFields) {
    if (!Object.prototype.hasOwnProperty.call(entry, field) || typeof entry[field] !== "string") {
      throw new Error(`${label} missing public lifecycle field: ${field}`);
    }
  }
  if (!entry.owner || !entry.maturity || !entry.introducedVersion || !entry.compatibilityPromise || !entry.sunsetCondition || !entry.nonDuplicationRationale) {
    throw new Error(`${label} has incomplete public lifecycle metadata`);
  }
}
for (const command of cliRegistry.commands || []) {
  if (!command.capabilityGroup || !capabilityGroupIds.has(command.capabilityGroup) || !Array.isArray(command.audience) || !command.maturity || !command.purpose || command.purpose.includes("Add a specific purpose")) {
    throw new Error(`cli-registry.json command missing capability metadata: ${command.id || command.usage}`);
  }
  assertPublicLifecycle(command, `cli-registry.json command ${command.id || command.usage}`);
}
const nodeApiRegistry = JSON.parse(fs.readFileSync(path.join(root, "dist/site/node-api-registry.json"), "utf8"));
for (const exported of nodeApiRegistry.exports || []) {
  if (!exported.capabilityGroup || !capabilityGroupIds.has(exported.capabilityGroup) || !Array.isArray(exported.audience) || !exported.maturity || !exported.summary) {
    throw new Error(`node-api-registry.json export missing capability metadata: ${exported.export || exported.specifier}`);
  }
  assertPublicLifecycle(exported, `node-api-registry.json export ${exported.export || exported.specifier}`);
}
assertPublicReferenceRegistry({ cliRegistry, nodeApiRegistry });
const workflowRegistry = JSON.parse(fs.readFileSync(path.join(root, "dist/site/workflow-registry.json"), "utf8"));
for (const workflow of workflowRegistry.workflows || []) {
  assertPublicLifecycle(workflow, `workflow-registry.json workflow ${workflow.id || workflow.path}`);
}
for (const action of workflowRegistry.actions || []) {
  assertPublicLifecycle(action, `workflow-registry.json action ${action.id || action.path}`);
}
const registeredActionIds = (workflowRegistry.actions || []).map((entry) => entry.id).sort();
const readmeActionIndex = fs.readFileSync(path.join(root, "README.md"), "utf8");
const mapActionIndex = fs.readFileSync(path.join(root, "docs/MAP.md"), "utf8");
const retrospectiveActionIndex = fs.readFileSync(path.join(root, ".github/retrospectives/2026-07-10-buildchain-consolidation.md"), "utf8");
if (registeredActionIds.length !== 7) {
  throw new Error(`workflow-registry.json must expose the seven current action entries, got ${registeredActionIds.length}`);
}
for (const actionId of registeredActionIds) {
  if (!readmeActionIndex.includes(`actions/${actionId}`) || !mapActionIndex.includes(`actions/${actionId}`)) {
    throw new Error(`README and docs/MAP.md must index registered action: ${actionId}`);
  }
}
if (!retrospectiveActionIndex.includes("snapshot of the four consumer-facing actions")) {
  throw new Error("the v2 four-action retrospective must remain explicitly classified as historical");
}
if (!pageRegistry.pages?.some((page) => page.sourcePath === "actions/promote-buildchain-ref/README.md")) {
  throw new Error("page-registry.json must include action manuals");
}
if (!pageRegistry.pages?.some((page) => page.sourcePath === "packages/core/README.md" && page.category === "api")) {
  throw new Error("page-registry.json must include Node API overview");
}
for (const requiredSnippet of [
  "createBuildchainKfdClaimRegistry",
  "createBuildchainKfd1Witness",
  "createBuildchainKfd2Claims",
  "createBuildchainKfd3PrebuildWitness",
  "BUILDCHAIN_AGENT_MANUALS",
  "collectPublicSurfaceReverseAudit",
  "assertPublicSurfaceReverseAudit",
]) {
  if (!coreIndexSource.includes(requiredSnippet)) {
    throw new Error(`packages/core/index.js must export Buildchain self KFD claim API: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "createKfd1ReleaseGateEvidence",
  "resolveKfd1Metadata",
  "validateKfd1ReleaseGateEvidence",
]) {
  if (!coreIndexSource.includes(requiredSnippet)) {
    throw new Error(`packages/core/index.js must export KFD-1 gate API: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "createKfd3CollaborationInterfaceReleaseGateEvidence",
  "resolveKfd3Metadata",
  "validateKfd3CollaborationInterfaceReleaseGateEvidence",
]) {
  if (!coreIndexSource.includes(requiredSnippet)) {
    throw new Error(`packages/core/index.js must export KFD-3 gate API: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "surfaceImpacts[]",
  "versionImpact.final",
  "kfd-registry-schema",
  "`v2.8`",
  "kfd-1-contract-world-release-gate",
  "required-check-protection",
  "`v2.2`",
  "GitHub-hosted runners for production",
  "Self-hosted runners remain compatibility fixtures",
]) {
  if (!versioningDoc.includes(requiredSnippet)) {
    throw new Error(`versioning doc missing required snippet: ${requiredSnippet}`);
  }
}
const releasePassportDoc = fs.readFileSync(path.join(root, "docs/release-passport.md"), "utf8");
for (const requiredSnippet of [
  "--kfd-1-witness-json",
  "--kfd-2-claim-json",
  "@kungfu-tech/kfd",
  "currently named `kfd-1`",
  "Buildchain formatting policy",
  "Verification fails closed",
  "KFD-2 release trust passport audit",
  "Unbound public claims fail",
  "buildFacts[]",
  "--build-facts-json",
  "Floating Buildchain contract lock",
  ".buildchain/contract-lock.json",
  "--kfd-3-prebuild-witness-json",
  "--kfd-3-artifact-verify-cmd",
  "currently named `kfd-3`",
  "KFD-3 collaboration-interface release gate",
  "release-passport-v1.schema.json",
  "release-passport-check-manifest.json",
  "Buildchain owns envelope aggregation",
]) {
  if (!releasePassportDoc.includes(requiredSnippet)) {
    throw new Error(`release passport doc missing KFD-1 gate snippet: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "Capability Coverage",
  "KFD-1 / KFD-2 / KFD-3",
  "floating `@v3`",
  "npm publish transactions",
  "Git/source/version/module/product build facts",
  "GitHub Release",
  "release propagation",
  "Homebrew tap distribution indexes",
  "capability-registry.json",
  "manual-registry.json",
  "node-api-registry.json",
  "README badge",
]) {
  if (!docsMap.includes(requiredSnippet)) {
    throw new Error(`documentation map missing capability coverage snippet: ${requiredSnippet}`);
  }
}
const readmeBadgesDoc = fs.readFileSync(path.join(root, "docs/readme-badges.md"), "utf8");
for (const requiredSnippet of [
  "buildchain badges bundle --check",
  "collectBadgeBundleFacts",
  "kungfu-buildchain-badge-bundle-facts",
  "@kungfu-tech/buildchain/badges",
  "[badges.bundle]",
  "buildchain badges readme --check",
  "collectReadmeBadgeFacts",
  "kungfu-buildchain-readme-badge-facts",
  "@kungfu-tech/kfd/standards.json",
  "badge-endpoint-registry.json",
  "badge_endpoint_base_url",
  "Buildchain-owned badges use stable hosted image URLs",
  "KFD passed",
  "Buildchain Release Passport",
  "release passport",
  "<!-- buildchain:badges:start -->",
]) {
  if (!readmeBadgesDoc.includes(requiredSnippet)) {
    throw new Error(`README badges doc missing required snippet: ${requiredSnippet}`);
  }
}
const homebrewDoc = fs.readFileSync(path.join(root, "docs/homebrew.md"), "utf8");
for (const requiredSnippet of [
  "project.type = \"distribution-index\"",
  "buildchain homebrew update-formula",
  "buildchain homebrew check",
  "collectHomebrewTapFacts",
  "kungfu-buildchain-homebrew-tap-manifest",
  "KFD passed",
]) {
  if (!homebrewDoc.includes(requiredSnippet)) {
    throw new Error(`Homebrew doc missing required snippet: ${requiredSnippet}`);
  }
}
const reusableBuildSurfaceDoc = fs.readFileSync(path.join(root, "docs/reusable-build-surface.md"), "utf8");
for (const requiredSnippet of [
  "Floating Ref Contract Lock",
  "dist/site/buildchain-contract.json",
  "buildchain-contract-drift-issue-mode",
  "compatible drift",
  "Locked Source Checkout Cache",
  "checkout-cache-mode",
  "BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE",
  "sourceCheckout",
  "Shifu Cache Profile Passthrough",
  "opaque reference and digest",
]) {
  if (!reusableBuildSurfaceDoc.includes(requiredSnippet)) {
    throw new Error(`reusable build surface doc missing contract lock snippet: ${requiredSnippet}`);
  }
}
for (const [docName, docSource] of Object.entries({ "docs/cli.md": cliDoc, "docs/install.md": installDoc })) {
  for (const requiredSnippet of [
    "minimumReleaseAgeExclude",
    "@kungfu-tech/buildchain@3.0.0",
    "package/version-specific",
  ]) {
    if (!docSource.includes(requiredSnippet)) {
      throw new Error(`${docName} missing fresh Buildchain package pin guidance: ${requiredSnippet}`);
    }
  }
}
for (const requiredSnippet of [
  "buildchain badges bundle --check",
  "buildchain badges bundle --write",
  "buildchain badges readme --check",
  "buildchain badges readme --write",
  "@kungfu-tech/buildchain/badges",
  "@kungfu-tech/buildchain/readme-badges",
  "buildchain homebrew update-formula",
  "buildchain homebrew check",
  "@kungfu-tech/buildchain/homebrew",
]) {
  if (!cliDoc.includes(requiredSnippet)) {
    throw new Error(`CLI doc missing README badge command snippet: ${requiredSnippet}`);
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
  "BUILDCHAIN_EMBEDDED_ENTRYPOINT",
  "noExternal: [\"smol-toml\",",
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
const binaryReleaseAssetsWorkflow = fs.readFileSync(path.join(root, ".github/workflows/.binary-release-assets.yml"), "utf8");
const selfHostedRunnerSmokeWorkflow = fs.readFileSync(path.join(root, ".github/workflows/self-hosted-runner-smoke.yml"), "utf8");
const npmDryRunScript = fs.readFileSync(path.join(root, "scripts/npm-publish-dry-run.mjs"), "utf8");
const npmPublishTransactionScript = fs.readFileSync(path.join(root, "scripts/npm-publish-transaction.mjs"), "utf8");
const rootPackageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const selfReleaseImpactPath = path.resolve(
  root,
  process.env.BUILDCHAIN_SELF_RELEASE_IMPACT_PATH || ".buildchain/release-impact.json",
);
const selfReleaseImpact = JSON.parse(fs.readFileSync(selfReleaseImpactPath, "utf8"));
assertSelfReleaseImpactContract(selfReleaseImpact, { expectedVersion: rootPackageJson.version });
if (!["patch", "minor", "major"].includes(selfReleaseImpact.classification)) {
  throw new Error("Buildchain self release impact classification must be patch, minor, or major");
}
if (!Array.isArray(selfReleaseImpact.surfaceImpacts) || selfReleaseImpact.surfaceImpacts.length === 0) {
  throw new Error("Buildchain self release impact requires a summary and surfaceImpacts[]");
}
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
  "actions: write",
  "uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@4524c40e97dd7f7f89a6fd2020b9aa89c1cc7f82\n",
  "github.event.workflow_run.event == 'push'",
  "!startsWith(github.event.workflow_run.display_title, 'chore(release): prepare v')",
  "!startsWith(github.event.workflow_run.display_title, 'chore(release): release v')",
  "resume-candidate-run-id:",
  "resume-expected-source-tree:",
  "resume-buildchain-runtime-sha:",
  "github-release: true",
  "release-passport-buildchain-self-kfd: true",
  'artifact-patterns: "buildchain-package-*"',
  "release-passport-impact-json: .buildchain/release-impact.json",
]) {
  if (!buildchainRefPromotionWorkflow.includes(requiredSnippet)) {
    throw new Error(`buildchain ref promotion workflow missing npm transaction snippet: ${requiredSnippet}`);
  }
}
const releaseCandidatePromoteWorkflow = fs.readFileSync(path.join(root, ".github/workflows/.release-candidate-promote.yml"), "utf8");
for (const requiredSnippet of [
  "release-passport-kfd-1-witness-jsons:",
  "release-passport-kfd-1-witness-jsons: ${{ inputs.release-passport-kfd-1-witness-jsons }}",
  "release-passport-kfd-2-claim-jsons:",
  "release-passport-kfd-2-claim-jsons: ${{ inputs.release-passport-kfd-2-claim-jsons }}",
  "release-passport-kfd-3-prebuild-witness-jsons:",
  "release-passport-kfd-3-prebuild-witness-jsons: ${{ inputs.release-passport-kfd-3-prebuild-witness-jsons }}",
  "release-passport-kfd-3-artifact-witness-jsons:",
  "release-passport-kfd-3-artifact-witness-jsons: ${{ inputs.release-passport-kfd-3-artifact-witness-jsons }}",
  "release-passport-kfd-3-artifact-verify-command:",
  "release-passport-kfd-support-matrix-json:",
  "release-passport-kfd-support-matrix-json: ${{ inputs.release-passport-kfd-support-matrix-json }}",
  "release-passport-kfd-product-gate-jsons:",
  "release-passport-kfd-product-gate-jsons: ${{ inputs.release-passport-kfd-product-gate-jsons }}",
  "release-passport-invariant-passport-jsons:",
  "release-passport-invariant-passport-jsons: ${{ inputs.release-passport-invariant-passport-jsons }}",
  "release-passport-invariant-passport-command:",
  "release-passport-invariant-passport-command: ${{ inputs.release-passport-invariant-passport-command }}",
  "release-passport-buildchain-self-kfd:",
  "release-passport-buildchain-self-kfd: ${{ inputs.release-passport-buildchain-self-kfd }}",
  "github-release:",
  "default: true",
  "github-release: ${{ inputs.github-release }}",
  "github-release-payload-patterns:",
  "github-release-artifact-paths: ${{ steps.rc.outputs.release-candidate-github-release-artifact-paths }}",
  "github-release-title: ${{ inputs.github-release-title }}",
  "github-release-notes: ${{ inputs.github-release-notes }}",
  "publication-commit-command:",
  "BUILDCHAIN_PUBLICATION_COMMIT_SIGNING_KEY:",
  "KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY:",
  "Commit consumer publication authority last",
  "node .buildchain/runtime/scripts/publication-commit-evidence.mjs",
  "require-publish-source-lock: \"true\"",
  "publish-source-ref: ${{ steps.publish-gate.outputs.ref }}",
  "publish-source-sha: ${{ steps.publish-gate.outputs.sha }}",
  "publish-source-locked: ${{ steps.publish-gate.outputs.locked }}",
  "expected-publication-version: ${{ needs.publication-plan.outputs.version }}",
  "publication-version: ${{ needs.publication-plan.outputs.version }}",
  "name: Plan exact publication version",
  "name: Install exact publication planning dependencies",
  "DRY_RUN: ${{ inputs.dry-run }}",
  "if (dryRun) {",
  "Enforce Buildchain stable release canary gate",
  "BUILDCHAIN_STABLE_RELEASE_POLICY: .buildchain/stable-release-policy.json",
  "Consumer has no binary-distribution.yml; standalone binary dispatch is not applicable.",
  "gh workflow view binary-distribution.yml",
  "resume-candidate-run-id:",
  "node .buildchain/runtime/scripts/resume-from-candidate-run.mjs",
  "publish-sealed-bundle-root: ${{ steps.rc.outputs.publish-sealed-bundle-root }}",
  "BUILDCHAIN_EXPECTED_TRANSACTION_ID: ${{ inputs.resume-transaction-id }}",
  "if: ${{ inputs.resume-candidate-run-id == '' }}",
  "Bridge Buildchain self-runtime dependencies",
  "ln -s .buildchain/runtime/node_modules node_modules",
]) {
  if (!releaseCandidatePromoteWorkflow.includes(requiredSnippet)) {
    throw new Error(`release candidate promote workflow missing KFD gate pass-through: ${requiredSnippet}`);
  }
}
const workflowDir = path.join(root, ".github/workflows");
for (const workflowFile of fs.readdirSync(workflowDir).filter((entry) => entry.endsWith(".yml"))) {
  const workflowPath = path.join(workflowDir, workflowFile);
  const workflowSource = fs.readFileSync(workflowPath, "utf8");
  if (!/uses:\s*(?:\.\/\.buildchain\/runtime\/actions\/promote-buildchain-ref|\.\/actions\/promote-buildchain-ref|.*\/actions\/promote-buildchain-ref(?:@|$))/m.test(workflowSource)) {
    continue;
  }
  for (const requiredSnippet of [
    "require-publish-source-lock:",
    "publish-source-ref:",
    "publish-source-sha:",
    "publish-source-locked:",
  ]) {
    if (!workflowSource.includes(requiredSnippet)) {
      throw new Error(`${workflowFile} calls promote-buildchain-ref without publish source-lock input: ${requiredSnippet}`);
    }
  }
}
for (const retiredWorkflow of [
  ".release-new-version.yml",
  ".release-elastic-beanstalk.yml",
  ".sam-release.yml",
  ".wheel-release.yml",
]) {
  const retiredSource = fs.readFileSync(path.join(workflowDir, retiredWorkflow), "utf8");
  for (const requiredSnippet of [
    "release path is retired",
    "release-candidate-promote.yml@v3",
    "publish-gate source-lock enforcement",
  ]) {
    if (!retiredSource.includes(requiredSnippet)) {
      throw new Error(`${retiredWorkflow} must fail closed and point callers at the source-locked release-candidate-promote model: ${requiredSnippet}`);
    }
  }
  for (const forbiddenSnippet of [
    "npm publish --access=public",
    "actions/publish-prebuilt@v2",
    "actions/bump-version@v2",
    "beanstalk-deploy@",
    "sam deploy",
  ]) {
    if (retiredSource.includes(forbiddenSnippet)) {
      throw new Error(`${retiredWorkflow} must not keep retired publish side effects: ${forbiddenSnippet}`);
    }
  }
}
const promoteBuildchainRefAction = fs.readFileSync(path.join(root, "actions/promote-buildchain-ref/action.yml"), "utf8");
const promoteBuildchainRefIndex = ["actions/promote-buildchain-ref/index.js", "actions/promote-buildchain-ref/github-release.js"].map((entry) => fs.readFileSync(path.join(root, entry), "utf8")).join("\n");
for (const requiredSnippet of [
  "github-release:",
  "github-release-title:",
  "github-release-notes:",
  "public-release-tag:",
  "github-release-url:",
  "github-release-action:",
]) {
  if (!promoteBuildchainRefAction.includes(requiredSnippet)) {
    throw new Error(`promote-buildchain-ref action missing GitHub Release surface: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "ensureGitHubRelease",
  "publishGitHubReleaseEvidence",
  "collectGitHubReleaseEvidenceAssets",
  "uploadReleaseAsset",
  "result.publishTransaction?.state === \"complete\"",
  "result.publishTransaction?.finalizationNeeded !== true",
]) {
  if (!promoteBuildchainRefIndex.includes(requiredSnippet)) {
    throw new Error(`promote-buildchain-ref index missing semver GitHub Release implementation: ${requiredSnippet}`);
  }
}
for (const forbiddenSnippet of [
  "uses: ./.github/workflows/.release-candidate-promote.yml",
  "uses: kungfu-systems/buildchain/.github/workflows/.release-candidate-promote.yml@",
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
  "BUILDCHAIN_SEALED_NPM_TARBALL",
  "...(pack.tarballPath ? [pack.tarballPath] : [])",
  "\"--access\"",
  "\"--tag\"",
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
  "verify artifact",
  "scripts/create-release-bundle.mjs",
  "buildchain-release-bundle",
  "--impact-json .buildchain/release-evidence/authoritative-release-state-impact.json",
]) {
  if (!binaryDistributionWorkflow.includes(requiredSnippet)) {
    throw new Error(`binary distribution workflow missing required snippet: ${requiredSnippet}`);
  }
}
for (const requiredSnippet of [
  "uses: ./.github/workflows/.publication-authority.yml",
  "environment: buildchain-release-assets",
  "needs: publication-authority",
  "scripts/ensure-github-release.mjs",
  "gh release upload",
  "capability.artifactDigest !== actualArtifact",
]) {
  if (!binaryReleaseAssetsWorkflow.includes(requiredSnippet)) {
    throw new Error(`binary release assets workflow missing required snippet: ${requiredSnippet}`);
  }
}
for (const forbiddenSnippet of ["contents: write", "id-token: write", "gh release upload"]) {
  if (binaryDistributionWorkflow.includes(forbiddenSnippet)) {
    throw new Error(`binary distribution evidence workflow must not carry product authority: ${forbiddenSnippet}`);
  }
}
for (const forbiddenSnippet of [
  "gh release create",
]) {
  if (binaryDistributionWorkflow.includes(forbiddenSnippet)) {
    throw new Error(`binary distribution workflow must not use unmanaged release metadata snippet: ${forbiddenSnippet}`);
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

if (inventory.stableRefs?.actions !== "kungfu-systems/buildchain/actions/<name>@v3") {
  throw new Error("inventory stable action ref must point at @v3");
}

if (inventory.stableRefs?.workflows !== "kungfu-systems/buildchain/.github/workflows/<workflow>.yml@v3") {
  throw new Error("inventory stable workflow ref must point at @v3");
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

if (badgeEndpointRegistry.contract !== "kungfu-buildchain-readme-badge-endpoint-registry") {
  throw new Error("badge-endpoint-registry.json must expose the README badge endpoint registry contract");
}
if (badgeEndpointRegistry.consumerActionForLogoChange !== "none") {
  throw new Error("badge endpoint registry must declare no consumer action for logo changes");
}
if (!badgeEndpointRegistry.badges?.some((entry) => entry.id === "buildchain-release-passport")) {
  throw new Error("badge endpoint registry must include Buildchain Release Passport badge");
}

for (const siteFile of ["buildchain-site.json", "site-manifest.json", "badge-endpoint-registry.json", "publication-registry.json", "page-registry.json", "capability-registry.json", "cli-registry.json", "manual-registry.json", "node-api-registry.json", "workflow-registry.json", "controller-registry.json", "public-surface-audit.json", "release-model.json", "release-passport-check-manifest.json", "schemas/release-passport-v1.schema.json", "buildchain-contract.json"]) {
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
