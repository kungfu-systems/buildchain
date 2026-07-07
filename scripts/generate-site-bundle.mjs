#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { createBuildchainContractWorld } from "../packages/core/buildchain-contract.js";
import {
  BUILDCHAIN_AGENT_MANUALS,
  createBuildchainKfdClaimRegistry,
} from "../packages/core/buildchain-kfd-claims.js";
import { createSurfaceTimestampPolicy } from "../packages/core/surface-manifest.js";

const SITE_BUNDLE_CONTRACT = "kungfu-buildchain-site-bundle";
const README_PATH = "README.md";
const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "dist", "site");

function readText(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function env(name) {
  return String(process.env[name] || "").trim();
}

function sha256File(rel) {
  const filePath = path.join(root, rel);
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`
    : "";
}

function existingJson(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function readExistingSiteTimestampPolicy(packageVersion) {
  const manifestPath = path.join(outputDir, "site-manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest?.package?.version !== packageVersion) return null;
    if (manifest?.timestampPolicy !== "ci-injected") return null;
    if (!manifest?.generatedAt || manifest.generatedAt === "1970-01-01T00:00:00.000Z") return null;
    return {
      generatedAt: manifest.generatedAt,
      publishedAt: manifest.publishedAt || manifest.generatedAt,
      sourceDateEpoch: manifest.sourceDateEpoch,
      sourceRevision: manifest.sourceRevision,
      timestampPolicy: manifest.timestampPolicy,
    };
  } catch {
    return null;
  }
}

function normalizeMarkdown(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function paragraphBlocks(markdown) {
  return normalizeMarkdown(markdown)
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, " ").trim())
    .filter(Boolean);
}

function parseReadme(markdown) {
  const content = normalizeMarkdown(markdown);
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (!titleMatch) {
    throw new Error(`${README_PATH} must start with an H1 title`);
  }

  const headingPattern = /^##\s+(.+)$/gm;
  const headings = [];
  let match;
  while ((match = headingPattern.exec(content))) {
    headings.push({
      title: match[1].trim(),
      index: match.index,
      bodyStart: headingPattern.lastIndex,
    });
  }

  const sections = {};
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const next = headings[index + 1];
    sections[current.title] = content.slice(current.bodyStart, next ? next.index : content.length).trim();
  }

  const intro = content.slice(titleMatch[0].length, headings[0]?.index ?? content.length).trim();
  return {
    title: titleMatch[1].trim(),
    intro,
    sections,
  };
}

function readmeSection(readme, heading) {
  const body = readme.sections[heading];
  if (!body) {
    throw new Error(`${README_PATH} missing required section: ${heading}`);
  }
  return body;
}

function homepageSection({ readme, id, heading, title = heading, role, priority, presentation, firstScreen = false }) {
  return {
    id,
    sourcePath: README_PATH,
    sourceHeading: heading,
    title,
    renderRole: role,
    homepagePriority: priority,
    defaultPresentation: presentation,
    includeInFirstScreen: firstScreen,
    markdown: normalizeMarkdown(readmeSection(readme, heading)),
  };
}

function docEntry(id, title, pathName, plane) {
  return {
    id,
    title,
    path: pathName,
    plane,
    exists: fs.existsSync(path.join(root, pathName)),
    digest: sha256File(pathName),
  };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "page";
}

function markdownTitle(markdown, fallback) {
  const match = normalizeMarkdown(markdown).match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function markdownHeadings(markdown) {
  const headings = [];
  const pattern = /^(#{1,4})\s+(.+)$/gm;
  let match;
  while ((match = pattern.exec(normalizeMarkdown(markdown)))) {
    headings.push({
      level: match[1].length,
      title: match[2].trim(),
      anchor: slugify(match[2]),
    });
  }
  return headings;
}

function listMarkdownFiles(dir) {
  const absoluteDir = path.join(root, dir);
  if (!fs.existsSync(absoluteDir)) return [];
  return fs.readdirSync(absoluteDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `${dir}/${name}`);
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

function sitePage(relPath, category, routePrefix, extra = {}) {
  const markdown = normalizeMarkdown(readText(relPath));
  const baseName = path.basename(relPath, path.extname(relPath));
  const parentName = path.basename(path.dirname(relPath));
  const slug = extra.slug || (baseName.toLowerCase() === "readme" ? slugify(parentName) : slugify(baseName));
  const route = extra.route || `${routePrefix}/${slug}`;
  const title = markdownTitle(markdown, extra.title || slug);
  return {
    id: extra.id || `${category}:${slug}`,
    title,
    route,
    category,
    sourcePath: relPath,
    digest: sha256File(relPath),
    headings: markdownHeadings(markdown),
    markdown,
    ...extra,
  };
}

function buildSitePages() {
  const docsPages = listMarkdownFiles("docs").map((relPath) => sitePage(relPath, "manual", "/docs"));
  const actionPages = immediateReadmes("actions").map((relPath) => sitePage(relPath, "action", "/actions"));
  const fixturePages = immediateReadmes("fixtures").map((relPath) => sitePage(relPath, "fixture", "/fixtures"));
  const apiPages = [
    sitePage("packages/core/README.md", "api", "/api", {
      id: "api:node-package",
      slug: "node-package",
      route: "/api/node-package",
    }),
  ];
  return [
    sitePage(README_PATH, "overview", "/", {
      id: "overview:home",
      slug: "home",
      route: "/",
      title: "Buildchain",
    }),
    ...docsPages,
    ...actionPages,
    ...apiPages,
    ...fixturePages,
  ].sort((a, b) => a.route.localeCompare(b.route));
}

function buildSiteBundle() {
  const packageJson = readJson("package.json");
  const inventory = readJson("tests/buildchain-inventory.json");
  const readme = parseReadme(readText(README_PATH));
  const docs = BUILDCHAIN_AGENT_MANUALS.map((manual) => docEntry(manual.id, manual.title, manual.path, manual.plane));
  const pages = buildSitePages();
  const preservedTimestampPolicy = readExistingSiteTimestampPolicy(packageJson.version);
  const generatedAtInput = env("BUILDCHAIN_SITE_GENERATED_AT") || env("BUILDCHAIN_SURFACE_GENERATED_AT");
  const publishedAtInput = env("BUILDCHAIN_SITE_PUBLISHED_AT") || env("BUILDCHAIN_SURFACE_PUBLISHED_AT");
  const timestampPolicyInput = env("BUILDCHAIN_SITE_TIMESTAMP_POLICY") || env("BUILDCHAIN_SURFACE_TIMESTAMP_POLICY");
  const sourceRevisionEnv = env("BUILDCHAIN_SOURCE_SHA");
  const shouldPreserveExistingTimestampPolicy =
    !generatedAtInput && !publishedAtInput && !timestampPolicyInput && !sourceRevisionEnv;
  const sourceRevisionInput =
    sourceRevisionEnv ||
    (generatedAtInput || publishedAtInput || timestampPolicyInput
      ? env("GITHUB_SHA")
      : shouldPreserveExistingTimestampPolicy
        ? preservedTimestampPolicy?.sourceRevision || ""
        : "");
  const timestampPolicy = createSurfaceTimestampPolicy({
    generatedAt: generatedAtInput || (shouldPreserveExistingTimestampPolicy ? preservedTimestampPolicy?.generatedAt : ""),
    publishedAt: publishedAtInput || (shouldPreserveExistingTimestampPolicy ? preservedTimestampPolicy?.publishedAt : ""),
    sourceDateEpoch: env("SOURCE_DATE_EPOCH") || (shouldPreserveExistingTimestampPolicy ? preservedTimestampPolicy?.sourceDateEpoch : "") || "0",
    sourceRevision: sourceRevisionInput,
    timestampPolicy: timestampPolicyInput || (shouldPreserveExistingTimestampPolicy ? preservedTimestampPolicy?.timestampPolicy : ""),
    deterministicInputs: [
      "README.md",
      "docs/*.md",
      "actions/*/README.md",
      "fixtures/*/README.md",
      "packages/core/README.md",
      "package.json#exports",
      "tests/buildchain-inventory.json",
    ],
    timestampFieldsParticipateInArtifactDigest: true,
    artifactDigestScope: "npm package dist/site JSON files",
  });

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
      { id: "homebrew", usage: "buildchain homebrew update-formula|check", purpose: "Generate and verify Homebrew tap Formula metadata as a distribution-index projection of upstream release passport evidence." },
    ],
  };

  const manualRegistry = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-agent-manual-registry",
    package: packageJson.name,
    source: "npm package docs/",
    manuals: docs.map((entry) => ({
      id: entry.id,
      title: entry.title,
      path: entry.path,
      plane: entry.plane,
      digest: entry.digest,
    })),
    requiredAgentManuals: [
      "docs/MAP.md",
      "docs/install.md",
      "docs/cli.md",
      "docs/reusable-build-surface.md",
      "docs/release-candidate.md",
      "docs/release-governance.md",
      "docs/release-passport.md",
      "docs/publish-transaction.md",
      "docs/homebrew.md",
      "docs/site-bundle-contract.md",
      "docs/runtime-train-validation.md",
      "docs/consumer-issue-reporting.md",
      "docs/ownership.md",
      "docs/migration-inventory.md",
    ],
    guidance: "Agent consumers should use this registry to find packaged Buildchain manuals before inferring behavior from workflow snippets or release notes.",
  };

  const pageRegistry = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-site-page-registry",
    package: packageJson.name,
    sourceOfTruth: "npm package @kungfu-tech/buildchain/dist/site/page-registry.json",
    rendererBoundary: {
      contentOwner: "Buildchain",
      rendererOwner: "site repository",
      rule: "Site repositories render these markdown pages and metadata; they do not maintain separate Buildchain product copy.",
    },
    pageCount: pages.length,
    categories: [...new Set(pages.map((page) => page.category))].sort(),
    pages,
  };

  const nodeApiRegistry = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-node-api-registry",
    package: packageJson.name,
    moduleSystem: packageJson.type || "module",
    exports: Object.entries(packageJson.exports || {})
      .filter(([specifier]) => !specifier.startsWith("./site/") && specifier !== "./package.json")
      .map(([specifier, target]) => ({
        specifier: specifier === "." ? packageJson.name : `${packageJson.name}/${specifier.replace(/^\.\//, "")}`,
        export: specifier,
        target,
        digest: typeof target === "string" ? sha256File(target.replace(/^\.\//, "")) : "",
      })),
    docs: [
      { id: "cli-and-node-package", path: "docs/cli.md", digest: sha256File("docs/cli.md") },
      { id: "readme-badges", path: "docs/readme-badges.md", digest: sha256File("docs/readme-badges.md") },
      { id: "homebrew", path: "docs/homebrew.md", digest: sha256File("docs/homebrew.md") },
      { id: "site-bundle-contract", path: "docs/site-bundle-contract.md", digest: sha256File("docs/site-bundle-contract.md") },
    ],
    guidance: "These are the public Node import surfaces shipped by the npm package. Agents should prefer these exports over internal file paths.",
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
      { id: "report-buildchain-issue", path: "actions/report-buildchain-issue", status: "active" },
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
    githubRelease: {
      exactTagRelease: true,
      prereleaseTags: "semver prerelease tags set prerelease=true and make_latest=false",
      stableTags: "stable semver tags set make_latest=true",
      evidenceAssets: [
        "publish evidence JSON",
        "buildchain.release.json",
        "release passport assets",
      ],
      owner: "promote-buildchain-ref",
    },
    distributionIndexes: {
      homebrewTap: {
        projectType: "distribution-index",
        manifest: "tap-manifest.json",
        command: "buildchain homebrew check",
        sourceOfTruth: "upstream release passport and sibling evidence",
      },
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
      "page-registry.json",
      "cli-registry.json",
      "manual-registry.json",
      "node-api-registry.json",
      "workflow-registry.json",
      "release-model.json",
      "artifact-schemas.json",
      "buildchain-contract.json",
      "kfd-claims.json",
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
    ...timestampPolicy,
    product: {
      name: "Buildchain",
      formalName: "Buildchain by Kungfu",
      category: "Buildchain Release Passport",
    },
    package: {
      name: packageJson.name,
      version: packageJson.version,
      versionSource: "package.json#version",
    },
    entrypoint: "buildchain-site.json",
    source: {
      homepageTextSource: README_PATH,
      docsMap: "docs/MAP.md",
      siteFactsDir: "dist/site",
    },
    docs,
    facts: [
      "page-registry.json",
      "cli-registry.json",
      "manual-registry.json",
      "node-api-registry.json",
      "workflow-registry.json",
      "release-model.json",
      "artifact-schemas.json",
      "product-mechanism.json",
      "release-provenance.json",
      "kfd-claims.json",
      "agent-index.json",
    ],
  };

  const agentIndex = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-site-agent-index",
    readOrder: [
      "site-manifest.json",
      "page-registry.json",
      "product-mechanism.json",
      "release-model.json",
      "cli-registry.json",
      "manual-registry.json",
      "node-api-registry.json",
      "workflow-registry.json",
      "artifact-schemas.json",
      "buildchain-contract.json",
      "kfd-claims.json",
    ],
    instruction: "Use this bundle as the package-owned fact source for Buildchain pages. Do not infer current release mechanics from prose alone.",
  };

  const homepageSections = [
    homepageSection({
      readme,
      id: "install-and-verify",
      heading: "Install and Verify",
      role: "primary",
      priority: 10,
      presentation: "release-passport-install",
      firstScreen: true,
    }),
    homepageSection({
      readme,
      id: "use-buildchain",
      heading: "Use Buildchain",
      role: "primary",
      priority: 20,
      presentation: "workflow-surface-list",
      firstScreen: true,
    }),
    homepageSection({
      readme,
      id: "release-model",
      heading: "Release Model",
      role: "primary",
      priority: 30,
      presentation: "release-model-table",
    }),
    homepageSection({
      readme,
      id: "toolkit-observability",
      heading: "Toolkit Observability",
      role: "support",
      priority: 40,
      presentation: "toolkit-example",
    }),
    homepageSection({
      readme,
      id: "site-fact-source",
      heading: "Site Fact Source",
      role: "support",
      priority: 50,
      presentation: "site-fact-source",
    }),
  ];

  const rendererContract = {
    ...homepageSection({
      readme,
      id: "homepage-content-contract",
      heading: "Homepage Content Contract",
      role: "renderer-contract",
      priority: 90,
      presentation: "developer-note",
    }),
    renderAsHomepageContent: false,
    note: "This is a machine/renderer contract for site implementers. It should not be rendered as ordinary homepage content.",
  };

  const siteBundle = {
    schemaVersion: 1,
    contract: SITE_BUNDLE_CONTRACT,
    ...timestampPolicy,
    product: siteManifest.product,
    package: siteManifest.package,
    source: {
      package: packageJson.name,
      homepageTextSource: README_PATH,
      docsMap: "docs/MAP.md",
      manualRegistry: "manual-registry.json",
      siteFactsDir: "dist/site",
    },
    routes: {
      home: "/",
      docsPattern: "/docs/{id}",
      llms: "/llms.txt",
      manifest: "/manifest.json",
    },
    sourceOfTruth: "npm package @kungfu-tech/buildchain/dist/site",
    humanFirst: true,
    agentFirst: true,
    entrypoints: siteManifest.facts.concat(["site-manifest.json"]),
    pages,
    pageRegistry: {
      path: "page-registry.json",
      contract: pageRegistry.contract,
      pageCount: pageRegistry.pageCount,
      categories: pageRegistry.categories,
    },
    homepage: {
      title: readme.title,
      lead: paragraphBlocks(readme.intro)[0] || "",
      mechanismSummary: paragraphBlocks(readme.intro).slice(1),
      sections: homepageSections,
      displayPlan: {
        firstScreen: {
          include: ["title", "lead", "install-and-verify", "use-buildchain"],
          maxPrimarySections: 2,
          note: "The first viewport should establish Buildchain identity, release-passport trust, and the primary reusable workflow entrypoint without rendering implementation notes.",
        },
        primary: ["install-and-verify", "use-buildchain", "release-model"],
        support: ["toolkit-observability", "site-fact-source"],
        rendererContract: ["homepage-content-contract"],
      },
      rendererContract,
    },
    docs,
    releaseModel,
    renderingBoundary: {
      ownedByBuildchain: [
        "homepage title and text",
        "homepage section projection from README.md",
        "complete markdown page registry for Buildchain public docs, action manuals, Node API overview, and fixtures",
        "release model facts",
        "workflow and action registries",
        "CLI command registry",
        "manual and Node API registries",
        "KFD claim registry",
        "release-passport evidence vocabulary",
      ],
      ownedBySite: [
        "HTML structure",
        "CSS",
        "responsive layout",
        "navigation layout",
        "visual assets",
        "decorative images",
        "markdown-to-HTML renderer",
        "section presentation and progressive disclosure within Buildchain displayPlan constraints",
      ],
    },
  };

  return {
    "buildchain-site.json": siteBundle,
    "site-manifest.json": siteManifest,
    "page-registry.json": pageRegistry,
    "cli-registry.json": cliRegistry,
    "manual-registry.json": manualRegistry,
    "node-api-registry.json": nodeApiRegistry,
    "workflow-registry.json": workflowRegistry,
    "release-model.json": releaseModel,
    "artifact-schemas.json": artifactSchemas,
    "buildchain-contract.json": createBuildchainContractWorld({ root }),
    "kfd-claims.json": createBuildchainKfdClaimRegistry({ root }),
    "product-mechanism.json": productMechanism,
    "release-provenance.json": releaseProvenance,
    "agent-index.json": agentIndex,
  };
}

export function writeSiteBundle({ check = false } = {}) {
  let files = buildSiteBundle();
  const mismatches = [];
  for (const [name, value] of Object.entries(files)) {
    const filePath = path.join(outputDir, name);
    const next = stableJson(value);
    if (check) {
      if (existingJson(filePath) !== next) {
        mismatches.push(path.relative(root, filePath));
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`site bundle is stale: ${mismatches.join(", ")}`);
  }
  if (!check) {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      for (const [name, value] of Object.entries(files)) {
        writeJson(path.join(outputDir, name), value);
      }
      const nextFiles = buildSiteBundle();
      const stable = Object.entries(nextFiles).every(([name, value]) => (
        existingJson(path.join(outputDir, name)) === stableJson(value)
      ));
      files = nextFiles;
      if (stable) {
        break;
      }
      if (iteration === 4) {
        throw new Error("site bundle did not converge after 5 generations");
      }
    }
    for (const [name, value] of Object.entries(files)) {
      writeJson(path.join(outputDir, name), value);
    }
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
