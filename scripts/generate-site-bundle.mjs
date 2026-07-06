#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SITE_BUNDLE_CONTRACT = "kungfu-buildchain-site-bundle";
const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "dist", "site");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function existingJson(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function docEntry(id, title, pathName, plane) {
  return {
    id,
    title,
    path: pathName,
    plane,
    exists: fs.existsSync(path.join(root, pathName)),
  };
}

function buildSiteBundle() {
  const packageJson = readJson("package.json");
  const inventory = readJson("tests/buildchain-inventory.json");
  const docs = [
    docEntry("install", "Install and verify Buildchain", "docs/install.md", "use"),
    docEntry("release-passport", "Release Passport protocol", "docs/release-passport.md", "verify"),
    docEntry("release-propagation", "Release propagation", "docs/release-propagation.md", "use"),
    docEntry("binary-distribution", "Binary distribution contract", "docs/binary-distribution.md", "verify"),
    docEntry("toolkit-observability", "Toolkit observability", "docs/toolkit-observability.md", "use"),
    docEntry("site-bundle-contract", "Site bundle contract", "docs/site-bundle-contract.md", "use"),
    docEntry("product-mechanism", "Product mechanism", "docs/product-mechanism.md", "why"),
    docEntry("cli", "CLI and npm package", "docs/cli.md", "use"),
    docEntry("lifecycle-protocol", "Lifecycle protocol", "docs/lifecycle-protocol.md", "use"),
    docEntry("reusable-build-surface", "Reusable build surface", "docs/reusable-build-surface.md", "use"),
    docEntry("publish-transaction", "Publish transaction", "docs/publish-transaction.md", "verify"),
    docEntry("release-governance", "Release governance", "docs/release-governance.md", "why"),
    docEntry("release-flow", "Release flow", "docs/release-flow.md", "verify"),
    docEntry("versioning", "Versioning", "docs/versioning.md", "why"),
    docEntry("web-surface-deployments", "Web surface deployments", "docs/web-surface-deployments.md", "use"),
    docEntry("infra-contract", "Infra Contract", "docs/infra-contract.md", "use"),
  ];

  const cliRegistry = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-cli-registry",
    binary: "buildchain",
    npmPackage: packageJson.name,
    commands: [
      { id: "version", usage: "buildchain version", purpose: "Print the package or embedded binary version." },
      { id: "init", usage: "buildchain init [--type package|native|web-surface|infra-contract|anchored-package]", purpose: "Bootstrap a repository with Buildchain configuration and caller workflow files." },
      { id: "validate", usage: "buildchain validate [--require-version-state]", purpose: "Validate buildchain.toml and declared lifecycle surfaces." },
      { id: "doctor", usage: "buildchain doctor [--json]", purpose: "Report local integration readiness." },
      { id: "lifecycle", usage: "buildchain lifecycle run <stage>", purpose: "Run configured lifecycle commands and write deterministic artifact manifests." },
      { id: "release-dry-run", usage: "buildchain release --dry-run --target-ref <ref>", purpose: "Explain what a channel merge would publish before the PR is merged." },
      { id: "collect-github-release", usage: "buildchain collect github-release --tag <tag>", purpose: "Collect release assets into a release passport." },
      { id: "verify-release-passport", usage: "buildchain verify release-passport <file-or-url>", purpose: "Fail closed unless a release passport and its evidence are complete." },
      { id: "release-propagation", usage: "buildchain release-propagation <plan|write-lock>", purpose: "Plan channel-preserving downstream release PRs and write exact upstream release locks." },
      { id: "verify-infra-contract-evidence-bundle", usage: "buildchain verify infra-contract-evidence-bundle <file>", purpose: "Fail closed unless an infra-contract lifecycle evidence bundle is complete, hash-bound, and validation-consistent." },
      { id: "logging", usage: "buildchain log|mark|span|verify observability-log", purpose: "Emit timestamped build events, summarize logs, and enforce required phases." },
      { id: "diagnostics-summary", usage: "buildchain diagnostics summary <diagnostics.json>...", purpose: "Summarize small diagnostics artifacts into JSON and a cross-platform lifecycle timing table." },
      { id: "npm-dry-run", usage: "buildchain npm dry-run --json", purpose: "Verify npm publish shape before a release transaction." },
      { id: "infra-contract", usage: "buildchain infra-contract --mode validate|ci|plan|contract|propagation-plan|propagation-apply|apply|evidence-bundle", purpose: "Validate and publish provider-neutral infrastructure contract evidence with a mutation-free CI evidence chain, provider command plans, configured provider command execution, saved-plan apply gates, dry-run-first propagation, and lifecycle evidence bundles." },
    ],
  };

  const workflowRegistry = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-workflow-registry",
    workflows: [
      { id: "build", path: ".github/workflows/.build.yml", surface: "reusable-build", status: "active" },
      { id: "web-surface", path: ".github/workflows/.web-surface.yml", surface: "site-app-deployment", status: "active" },
      { id: "buildchain-ref-promotion", path: ".github/workflows/buildchain-ref-promotion.yml", surface: "release-governance", status: "active" },
      { id: "release-propagation", path: ".github/workflows/release-propagation.yml", surface: "release-propagation", status: "preview" },
      { id: "dev-pr-auto-merge", path: ".github/workflows/dev-pr-auto-merge.yml", surface: "dev-governance", status: "active" },
      { id: "binary-distribution", path: ".github/workflows/binary-distribution.yml", surface: "release-passport", status: "active" },
    ],
    actions: [
      { id: "validate-config", path: "actions/validate-config", status: "active" },
      { id: "run-lifecycle", path: "actions/run-lifecycle", status: "active" },
      { id: "promote-buildchain-ref", path: "actions/promote-buildchain-ref", status: "active" },
    ],
  };

  const releaseModel = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-model",
    exactTags: "v-prefixed exact tags are immutable release records.",
    floatingTags: "vX, vX.Y, and vX.Y-alpha are channel pointers updated by Buildchain transactions.",
    channelBranches: ["dev/vX/vX.Y", "alpha/vX/vX.Y", "release/vX/vX.Y", "publish-gate/major"],
    protectedDevelopmentBranches: ["dev/vX/vX.Y"],
    releasePassport: {
      entrypoint: "buildchain.release.json",
      bundle: "buildchain-release-bundle.tar.gz",
      contract: "kungfu-buildchain-release-passport",
    },
    releasePropagation: {
      graphContract: "kungfu-buildchain-release-propagation-graph",
      planContract: "kungfu-buildchain-release-propagation-plan",
      lockContract: "kungfu-buildchain-release-propagation-lock",
      defaultChannelPolicy: "preserve",
      defaultChannelMap: { alpha: "alpha", release: "release" },
    },
    npm: {
      package: packageJson.name,
      command: packageJson.bin?.buildchain || "",
      versionSource: "package.json#version",
      alphaDistTag: "alpha",
      stableDistTag: "latest",
    },
  };

  const artifactSchemas = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-schema-index",
    releasePassport: [
      "buildchain.release.json",
      "artifact-evidence.json",
      "product-mechanism.json",
      "impact.json",
      "agent-index.json",
      "check-report.json",
      "llms.txt",
      "buildchain-release-bundle.json",
      "buildchain-release-bundle.tar.gz",
    ],
    site: [
      "buildchain-site.json",
      "site-manifest.json",
      "cli-registry.json",
      "workflow-registry.json",
      "release-model.json",
      "artifact-schemas.json",
      "product-mechanism.json",
      "release-provenance.json",
      "agent-index.json",
    ],
    infraContract: [
      "infra-contract-plan.json",
      "buildchain.infra-contract.json",
      "infra-contract-propagation.json",
    ],
  };

  const productMechanism = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-product-mechanism",
    name: "Buildchain",
    formalName: "Buildchain by Kungfu",
    category: "Buildchain Release Passport",
    purpose: "A mature product release record for artifacts that users or agents depend on.",
    executionSubstrate: "GitHub Actions, protected refs, exact tags, GitHub Releases, npm Trusted Publishing, and machine-readable evidence.",
    notA: [
      "a replacement CI/CD platform",
      "a binary-only release tool",
      "a workflow file collection as the product boundary",
    ],
    proofCases: [
      "multi-platform CLI archives",
      "npm package publication",
      "native and multi-artifact release passports",
      "site facts consumed by buildchain.libkungfu.dev",
    ],
  };

  const releaseProvenance = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-provenance",
    package: {
      name: packageJson.name,
      versionSource: "package.json#version",
      bin: packageJson.bin,
      exports: packageJson.exports,
    },
    repository: packageJson.repository,
    packageManager: packageJson.packageManager,
    inventoryRelease: inventory.release,
    stableRefs: inventory.stableRefs,
  };

  const siteManifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-site-manifest",
    product: {
      name: "Buildchain",
      formalName: "Buildchain by Kungfu",
      category: "Buildchain Release Passport",
    },
    package: {
      name: packageJson.name,
      versionSource: "package.json#version",
    },
    entrypoint: "buildchain-site.json",
    docs,
    facts: [
      "cli-registry.json",
      "workflow-registry.json",
      "release-model.json",
      "artifact-schemas.json",
      "product-mechanism.json",
      "release-provenance.json",
      "agent-index.json",
    ],
  };

  const agentIndex = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-site-agent-index",
    readOrder: [
      "site-manifest.json",
      "product-mechanism.json",
      "release-model.json",
      "cli-registry.json",
      "workflow-registry.json",
      "artifact-schemas.json",
    ],
    instruction: "Use this bundle as the package-owned fact source for Buildchain pages. Do not infer current release mechanics from prose alone.",
  };

  const siteBundle = {
    schemaVersion: 1,
    contract: SITE_BUNDLE_CONTRACT,
    product: siteManifest.product,
    package: siteManifest.package,
    sourceOfTruth: "npm package @kungfu-tech/buildchain/dist/site",
    humanFirst: true,
    agentFirst: true,
    entrypoints: siteManifest.facts.concat(["site-manifest.json"]),
    docs,
    releaseModel,
  };

  return {
    "buildchain-site.json": siteBundle,
    "site-manifest.json": siteManifest,
    "cli-registry.json": cliRegistry,
    "workflow-registry.json": workflowRegistry,
    "release-model.json": releaseModel,
    "artifact-schemas.json": artifactSchemas,
    "product-mechanism.json": productMechanism,
    "release-provenance.json": releaseProvenance,
    "agent-index.json": agentIndex,
  };
}

export function writeSiteBundle({ check = false } = {}) {
  const files = buildSiteBundle();
  const mismatches = [];
  for (const [name, value] of Object.entries(files)) {
    const filePath = path.join(outputDir, name);
    const next = stableJson(value);
    if (check) {
      if (existingJson(filePath) !== next) {
        mismatches.push(path.relative(root, filePath));
      }
    } else {
      writeJson(filePath, value);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`site bundle is stale: ${mismatches.join(", ")}`);
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-site-bundle-generation",
    outputDir: path.relative(root, outputDir),
    files: Object.keys(files).sort(),
    check,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = writeSiteBundle({ check: process.argv.includes("--check") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`buildchain site bundle: ${error.message}`);
    process.exitCode = 1;
  }
}
