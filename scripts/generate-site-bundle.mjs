#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createBuildchainContractWorld } from "../packages/core/buildchain-contract.js";
import { createControllerRegistry } from "../packages/core/controller-evidence.js";
import { createBuildchainPublicationAuthorityRegistry } from "../packages/core/buildchain-publication-authority.js";
import {
  BUILDCHAIN_AGENT_MANUALS,
  createBuildchainKfdClaimRegistry,
} from "../packages/core/buildchain-kfd-claims.js";
import {
  collectKfdUpstreamFacts,
} from "../packages/core/kfd.js";
import {
  createReadmeBadgeEndpointRegistry,
} from "../packages/core/readme-badges.js";
import {
  collectPublicSurfaceReverseAudit,
  enumerateActionInputs,
  enumerateCliCommandsFromBin,
  enumerateWorkflowInputs,
} from "../packages/core/public-surface-audit.js";
import { createSurfaceTimestampPolicy } from "../packages/core/surface-manifest.js";

const SITE_BUNDLE_CONTRACT = "kungfu-buildchain-site-bundle";
const PUBLICATION_RELEASE_REGISTRY_CONTRACT = "kungfu-buildchain-publication-release-registry";
const README_PATH = "README.md";
const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "dist", "site");
const requireFromHere = createRequire(import.meta.url);

function readText(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function readPackageKfdStandards() {
  const standardsPath = requireFromHere.resolve("@kungfu-tech/kfd/standards.json", {
    paths: [root],
  });
  return JSON.parse(fs.readFileSync(standardsPath, "utf8"));
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
  const meta = pageCapabilityMeta(relPath, category);
  return {
    id: extra.id || `${category}:${slug}`,
    title,
    route,
    category,
    capabilityGroup: meta.capabilityGroup,
    audience: meta.audience,
    maturity: meta.maturity,
    sourcePath: relPath,
    digest: sha256File(relPath),
    headings: markdownHeadings(markdown),
    markdown,
    ...extra,
  };
}

const CAPABILITY_GROUPS = Object.freeze([
  {
    id: "getting-started",
    title: "Getting Started",
    summary: "Install Buildchain, understand the product mechanism, and choose the right entrypoint.",
    audience: ["consumer", "agent"],
    maturity: "stable",
  },
  {
    id: "release-passport-trust",
    title: "Release Passport and Trust",
    summary: "Create, verify, explain, and publish release passports, KFD trust evidence, GitHub Releases, and binary assets.",
    audience: ["release-operator", "agent"],
    maturity: "stable",
  },
  {
    id: "reusable-build",
    title: "Reusable Build and Lifecycle",
    summary: "Run reusable package/native builds, lifecycle stages, release candidates, source locks, and self-hosted artifact transfer.",
    audience: ["consumer", "release-operator"],
    maturity: "stable",
  },
  {
    id: "kfd-trust",
    title: "KFD Trust and Surface Closure",
    summary: "Discover KFD trust support, public surface reverse audits, and product capability queries.",
    audience: ["agent", "maintainer"],
    maturity: "stable",
  },
  {
    id: "site-and-propagation",
    title: "Site Bundle, Web Surfaces, and Propagation",
    summary: "Publish package-owned site facts, web-surface previews/staging/production, and downstream release propagation.",
    audience: ["site", "release-operator", "agent"],
    maturity: "stable",
  },
  {
    id: "distribution-indexes",
    title: "Distribution Indexes and Badges",
    summary: "Generate README badge facts and distribution-index projections such as Homebrew taps from release passport evidence.",
    audience: ["consumer", "site", "agent"],
    maturity: "stable",
  },
  {
    id: "observability-diagnostics",
    title: "Build Facts, Observability, and Diagnostics",
    summary: "Collect source/module/product facts, lifecycle logs, diagnostics summaries, and process-tree evidence.",
    audience: ["maintainer", "agent"],
    maturity: "stable",
  },
  {
    id: "governance-versioning",
    title: "Governance, Versioning, and Runtime Drift",
    summary: "Operate protected dev lines, semver line bootstrap, runtime trains, floating-ref contract locks, and ownership boundaries.",
    audience: ["maintainer", "release-operator"],
    maturity: "stable",
  },
  {
    id: "api-cli-reference",
    title: "CLI and Node API Reference",
    summary: "Enumerate supported CLI commands, Node package exports, workflow/action inputs, and packaged manuals.",
    audience: ["agent", "developer"],
    maturity: "stable",
  },
]);

const CAPABILITY_GROUP_BY_ID = new Map(CAPABILITY_GROUPS.map((group) => [group.id, group]));

function capabilityGroup(id) {
  if (!CAPABILITY_GROUP_BY_ID.has(id)) {
    throw new Error(`unknown capability group: ${id}`);
  }
  return id;
}

const manualMetaById = new Map(Object.entries({
  map: { capabilityGroup: "getting-started", audience: ["agent", "consumer"], maturity: "stable", order: 10 },
  install: { capabilityGroup: "getting-started", audience: ["consumer"], maturity: "stable", order: 20 },
  "product-mechanism": { capabilityGroup: "getting-started", audience: ["agent", "maintainer"], maturity: "stable", order: 30 },
  cli: { capabilityGroup: "api-cli-reference", audience: ["agent", "developer"], maturity: "stable", order: 40 },
  "release-passport": { capabilityGroup: "release-passport-trust", audience: ["release-operator", "agent"], maturity: "stable", order: 100 },
  "publication-authority": { capabilityGroup: "release-passport-trust", audience: ["release-operator", "agent"], maturity: "preview", order: 105 },
  "controller-evidence": { capabilityGroup: "reusable-build", audience: ["consumer", "release-operator", "agent"], maturity: "draft", order: 205 },
  "binary-distribution": { capabilityGroup: "release-passport-trust", audience: ["release-operator", "agent"], maturity: "stable", order: 110 },
  "publish-transaction": { capabilityGroup: "release-passport-trust", audience: ["release-operator"], maturity: "stable", order: 120 },
  "release-candidate": { capabilityGroup: "reusable-build", audience: ["release-operator", "consumer"], maturity: "stable", order: 130 },
  "stable-candidate-patrol": { capabilityGroup: "governance-versioning", audience: ["release-operator", "consumer"], maturity: "preview", order: 135 },
  "reusable-build-surface": { capabilityGroup: "reusable-build", audience: ["consumer", "release-operator"], maturity: "stable", order: 200 },
  "lifecycle-protocol": { capabilityGroup: "reusable-build", audience: ["consumer", "developer"], maturity: "stable", order: 210 },
  "runtime-train-validation": { capabilityGroup: "governance-versioning", audience: ["maintainer", "consumer"], maturity: "stable", order: 220 },
  "kfd-support": { capabilityGroup: "kfd-trust", audience: ["agent", "maintainer"], maturity: "stable", order: 300 },
  "site-bundle-contract": { capabilityGroup: "site-and-propagation", audience: ["site", "agent"], maturity: "stable", order: 400 },
  "web-surface-deployments": { capabilityGroup: "site-and-propagation", audience: ["site", "release-operator"], maturity: "stable", order: 410 },
  "release-propagation": { capabilityGroup: "site-and-propagation", audience: ["release-operator", "agent"], maturity: "preview", order: 420 },
  "publication-artifacts": { capabilityGroup: "reusable-build", audience: ["consumer", "site", "agent"], maturity: "stable", order: 430 },
  "readme-badges": { capabilityGroup: "distribution-indexes", audience: ["consumer", "site"], maturity: "stable", order: 500 },
  homebrew: { capabilityGroup: "distribution-indexes", audience: ["consumer", "release-operator"], maturity: "stable", order: 510 },
  "build-facts": { capabilityGroup: "observability-diagnostics", audience: ["maintainer", "agent"], maturity: "stable", order: 600 },
  "toolkit-observability": { capabilityGroup: "observability-diagnostics", audience: ["developer", "maintainer"], maturity: "stable", order: 610 },
  "consumer-issue-reporting": { capabilityGroup: "observability-diagnostics", audience: ["consumer", "maintainer"], maturity: "stable", order: 620 },
  "release-governance": { capabilityGroup: "governance-versioning", audience: ["maintainer", "release-operator"], maturity: "stable", order: 700 },
  "release-flow": { capabilityGroup: "governance-versioning", audience: ["release-operator", "agent"], maturity: "stable", order: 710 },
  versioning: { capabilityGroup: "governance-versioning", audience: ["maintainer"], maturity: "stable", order: 720 },
  ownership: { capabilityGroup: "governance-versioning", audience: ["maintainer"], maturity: "stable", order: 730 },
  "migration-inventory": { capabilityGroup: "governance-versioning", audience: ["maintainer", "agent"], maturity: "stable", order: 740 },
  "infra-contract": { capabilityGroup: "governance-versioning", audience: ["maintainer", "consumer"], maturity: "preview", order: 750 },
}).map(([id, meta]) => [id, { ...meta, capabilityGroup: capabilityGroup(meta.capabilityGroup) }]));

function manualMeta(id) {
  const meta = manualMetaById.get(id);
  if (!meta) {
    throw new Error(`missing manual capability metadata: ${id}`);
  }
  return meta;
}

function pageCapabilityMeta(relPath, category) {
  if (relPath === README_PATH) {
    return { capabilityGroup: capabilityGroup("getting-started"), audience: ["consumer", "agent"], maturity: "stable" };
  }
  const manual = BUILDCHAIN_AGENT_MANUALS.find((entry) => entry.path === relPath);
  if (manual) {
    return manualMeta(manual.id);
  }
  if (category === "action") {
    return { capabilityGroup: capabilityGroup("api-cli-reference"), audience: ["developer", "agent"], maturity: "stable" };
  }
  if (category === "fixture") {
    return { capabilityGroup: capabilityGroup("reusable-build"), audience: ["developer", "agent"], maturity: "stable" };
  }
  if (category === "api") {
    return { capabilityGroup: capabilityGroup("api-cli-reference"), audience: ["developer", "agent"], maturity: "stable" };
  }
  return { capabilityGroup: capabilityGroup("getting-started"), audience: ["agent"], maturity: "stable" };
}

function cliCommandMeta(id) {
  const map = new Map(Object.entries({
    audit: { group: "release-passport-trust", purpose: "Inspect read-only publication authority audit commands." },
    "audit-publication-control-plane": { group: "release-passport-trust", purpose: "Read GitHub publication controls, bind provider-enforced npm identity, and emit a sanitized expiring receipt." },
    badges: { group: "distribution-indexes", purpose: "Inspect README badge command families." },
    "badges-bundle": { group: "distribution-indexes", purpose: "Generate or verify the combined KFD and Release Passport badge bundle." },
    "badges-readme": { group: "distribution-indexes", purpose: "Generate or verify managed README badge blocks." },
    "build-contract": { group: "governance-versioning", purpose: "Resolve Buildchain runtime contract metadata for floating-ref drift checks." },
    "build-facts": { group: "observability-diagnostics", purpose: "Collect and verify Git source, version, module output, product artifact, and legacy Kungfu buildinfo facts." },
    collect: { group: "release-passport-trust", purpose: "Inspect release evidence collection command families." },
    "collect-github-release": { group: "release-passport-trust", purpose: "Collect GitHub Release assets into a release passport." },
    create: { group: "release-passport-trust", purpose: "Create canonical sealed publication evidence documents." },
    "create-publication-admission": { group: "release-passport-trust", purpose: "Create a canonical short-lived publication admission envelope from exact consumer bindings." },
    "create-runner-provenance": { group: "release-passport-trust", purpose: "Create runner provenance evidence with an explicit qualification floor." },
    diagnostics: { group: "observability-diagnostics", purpose: "Inspect diagnostics command families." },
    "diagnostics-summary": { group: "observability-diagnostics", purpose: "Summarize diagnostics artifacts into JSON and cross-platform lifecycle timing tables." },
    doctor: { group: "getting-started", purpose: "Report local integration readiness." },
    explain: { group: "release-passport-trust", purpose: "Inspect release and artifact explanation command families." },
    "explain-artifact": { group: "release-passport-trust", purpose: "Explain artifact evidence for humans or agents." },
    "explain-release": { group: "release-passport-trust", purpose: "Explain a release passport for humans or agents." },
    facts: { group: "observability-diagnostics", purpose: "Inspect build facts command families." },
    help: { group: "getting-started", purpose: "Print Buildchain CLI help." },
    homebrew: { group: "distribution-indexes", purpose: "Inspect Homebrew distribution-index command families." },
    "homebrew-check": { group: "distribution-indexes", purpose: "Verify Homebrew tap metadata against upstream release passport evidence." },
    "homebrew-update-formula": { group: "distribution-indexes", purpose: "Generate Homebrew Formula metadata from upstream release passport evidence." },
    "infra-contract": { group: "governance-versioning", purpose: "Validate and publish provider-neutral infrastructure contract evidence." },
    init: { group: "getting-started", purpose: "Bootstrap a repository with Buildchain configuration and caller workflow files." },
    inspect: { group: "release-passport-trust", purpose: "Inspect release and artifact evidence command families." },
    "inspect-artifact": { group: "release-passport-trust", purpose: "Inspect artifact evidence." },
    "inspect-release": { group: "release-passport-trust", purpose: "Inspect release passport evidence." },
    kfd: { group: "kfd-trust", purpose: "Inspect KFD standards, schemas, and versioned KFD command families." },
    layout: { group: "kfd-trust", purpose: "Return the versioned repository-layout and KFD registry discovery contract for tools such as Shifu." },
    "kfd-schema": { group: "kfd-trust", purpose: "Inspect KFD schema command families." },
    "kfd-schema-list": { group: "kfd-trust", purpose: "List machine-readable schemas exposed by the KFD package standards metadata." },
    "kfd-schema-show": { group: "kfd-trust", purpose: "Print a machine-readable KFD schema from the KFD package standards metadata." },
    "kfd-status": { group: "kfd-trust", purpose: "Report implemented KFD support and the active .buildchain repository layout." },
    "kfd-migrate-layout": { group: "kfd-trust", purpose: "Plan or apply migration of legacy root Buildchain files into .buildchain/." },
    "kfd-1": { group: "kfd-trust", purpose: "Inspect KFD-1 contract-world witness, gate, verify, and schema command families." },
    "kfd-1-gate": { group: "kfd-trust", purpose: "Generate KFD-1 release gate evidence from declared contract-world witnesses." },
    "kfd-1-schema": { group: "kfd-trust", purpose: "Print the default KFD-1 schema exposed by the KFD package standards metadata." },
    "kfd-1-verify": { group: "kfd-trust", purpose: "Validate KFD-1 release gate evidence." },
    "kfd-1-witness": { group: "kfd-trust", purpose: "Generate Buildchain's KFD-1 self contract-world witness." },
    "kfd-2": { group: "kfd-trust", purpose: "Inspect KFD-2 trust taxonomy, public claims, and schema command families." },
    "kfd-2-claims": { group: "kfd-trust", purpose: "Generate Buildchain's KFD-2 public trust claim evidence." },
    "kfd-2-product-claims": { group: "kfd-trust", purpose: "Validate and render product-owned KFD-2 claims in the canonical .buildchain/kfd layout." },
    "kfd-2-schema": { group: "kfd-trust", purpose: "Print the default KFD-2 schema exposed by the KFD package standards metadata." },
    "kfd-2-taxonomy": { group: "kfd-trust", purpose: "Validate KFD-2 trust taxonomy entries from the KFD package standards metadata." },
    "kfd-2-trust-assessment": { group: "kfd-trust", purpose: "Expose and validate the KFD package foundation KFD-2 trust assessment." },
    "kfd-2-trust-claims": { group: "kfd-trust", purpose: "Expose and validate the KFD package foundation KFD-2 trust claims." },
    "kfd-3": { group: "kfd-trust", purpose: "Inspect KFD-3 surface detection, registry, witness, audit, and query command families under the unified KFD namespace." },
    "kfd-3-audit": { group: "kfd-trust", purpose: "Compare detected, declared, and enforced KFD-3 public surfaces." },
    "kfd-3-detect": { group: "kfd-trust", purpose: "Detect standard KFD-3 public surface candidates from source and artifact metadata." },
    "kfd-3-query": { group: "kfd-trust", purpose: "Return an agent-readable KFD-3 capability map for a product, registry, or release passport." },
    "kfd-3-register": { group: "kfd-trust", purpose: "Declare detected KFD-3 public surfaces into a product-owned surface registry." },
    "kfd-3-witness": { group: "kfd-trust", purpose: "Generate release-passport-compatible KFD-3 surface witnesses from a product registry." },
    "kfd-4-schema": { group: "kfd-trust", purpose: "Print the default KFD-4 schema exposed by the KFD package standards metadata." },
    "kfd-aggregate": { group: "kfd-trust", purpose: "Return a product KFD view that combines own KFD status with upstream KFD aggregate facts." },
    "kfd-upstream": { group: "kfd-trust", purpose: "Inspect KFD upstream aggregate command families." },
    "kfd-upstream-check": { group: "kfd-trust", purpose: "Validate a KFD upstream aggregate document and fail closed on missing evidence." },
    "kfd-upstream-collect": { group: "kfd-trust", purpose: "Collect declared KFD-aware upstream package evidence and hashes from Buildchain config." },
    "kfd-upstream-roles": { group: "kfd-trust", purpose: "List Buildchain-managed KFD upstream role values and inference policy." },
    lifecycle: { group: "reusable-build", purpose: "Run configured lifecycle commands and write deterministic artifact manifests." },
    log: { group: "observability-diagnostics", purpose: "Inspect Buildchain logging command families." },
    logging: { group: "observability-diagnostics", purpose: "Emit timestamped build events, summarize logs, and enforce required phases." },
    mark: { group: "observability-diagnostics", purpose: "Emit a single Buildchain log event." },
    npm: { group: "release-passport-trust", purpose: "Inspect npm publishing command families." },
    "npm-dry-run": { group: "release-passport-trust", purpose: "Verify npm publish shape before a release transaction." },
    "publish-source": { group: "release-passport-trust", purpose: "Create, inspect, or verify publish-gate source-lock refs." },
    "publication-artifact": { group: "reusable-build", purpose: "Generate publication artifact manifests, passports, and source bundles for paper/report repositories." },
    "publication-artifact-manifest": { group: "reusable-build", purpose: "Write a site-consumable publication artifact manifest, publication passport, and source bundle." },
    "publication-artifact-npm-package": { group: "reusable-build", purpose: "Synthesize the declared npm paper package from a publication artifact manifest, passport, registry, source bundle, and primary artifact." },
    "release-dry-run": { group: "governance-versioning", purpose: "Explain what a channel merge would publish before the PR is merged." },
    "release-line-open": { group: "governance-versioning", purpose: "Plan or write the initial version-state commit for a new minor release line." },
    "release-propagation": { group: "site-and-propagation", purpose: "Plan channel-preserving downstream release PRs and write exact upstream release locks." },
    "release-transaction": { group: "release-passport-trust", purpose: "Inspect, recover, finalize, or abort durable release transactions." },
    sample: { group: "observability-diagnostics", purpose: "Inspect sampler command families." },
    "sample-process-tree": { group: "observability-diagnostics", purpose: "Sample process-tree diagnostics for a wrapped command." },
    span: { group: "observability-diagnostics", purpose: "Run a command inside a Buildchain log span." },
    "transaction-inspect": { group: "release-passport-trust", purpose: "Inspect durable release transaction state." },
    validate: { group: "getting-started", purpose: "Validate .buildchain/buildchain.toml and declared lifecycle surfaces." },
    verify: { group: "release-passport-trust", purpose: "Inspect release and artifact verification command families." },
    "verify-artifact": { group: "release-passport-trust", purpose: "Verify artifact subjects against release passport evidence." },
    "verify-infra-contract-evidence-bundle": { group: "governance-versioning", purpose: "Fail closed unless an infra-contract lifecycle evidence bundle is complete, hash-bound, and validation-consistent." },
    "verify-observability-log": { group: "observability-diagnostics", purpose: "Verify Buildchain observability log events." },
    "verify-publication-admission": { group: "release-passport-trust", purpose: "Independently verify sealed publication admission, runner provenance, control-plane audit, nonce freshness, and exact artifact bindings." },
    "verify-release-passport": { group: "release-passport-trust", purpose: "Fail closed unless a release passport and its evidence are complete." },
    version: { group: "getting-started", purpose: "Print the package or embedded binary version." },
    "web-surface": { group: "site-and-propagation", purpose: "Plan, verify, and apply Buildchain web-surface deployments." },
  }));
  const meta = map.get(id);
  if (!meta) {
    throw new Error(`missing CLI command capability metadata: ${id}`);
  }
  return { capabilityGroup: capabilityGroup(meta.group), purpose: meta.purpose, audience: ["agent", "operator"], maturity: "stable" };
}

function nodeApiMeta(exportName) {
  const map = new Map(Object.entries({
    ".": { group: "api-cli-reference", summary: "Root toolkit export for Buildchain's public Node API." },
    "./core": { group: "api-cli-reference", summary: "Alias for the root public toolkit export." },
    "./badges": { group: "distribution-indexes", summary: "Badge bundle facts, rendering, checking, and update APIs." },
    "./readme-badges": { group: "distribution-indexes", summary: "Managed README badge block facts, rendering, drift checks, and updates." },
    "./homebrew": { group: "distribution-indexes", summary: "Homebrew tap fact collection, Formula rendering, update, and check APIs." },
    "./build-facts": { group: "observability-diagnostics", summary: "Git source, version, module output, product artifact, and legacy Kungfu build fact APIs." },
    "./diagnostics": { group: "observability-diagnostics", summary: "Native diagnostics collection, summarization, cache, compiler, and process-sampler APIs." },
    "./logging": { group: "observability-diagnostics", summary: "Buildchain JSONL logging, span, summary, and verification APIs." },
    "./publication-artifact": { group: "reusable-build", summary: "Publication artifact manifest, source bundle, and publication passport APIs." },
    "./publication-package": { group: "reusable-build", summary: "Publication npm package synthesis APIs for Buildchain-managed paper release presets." },
    "./publication-authority": { group: "release-passport-trust", summary: "Sealed publication authority registry, runner provenance, control-plane audit, admission, and independent verification APIs." },
    "./publication-control-plane-audit": { group: "release-passport-trust", summary: "Read-only publication control-plane snapshot evaluation APIs." },
    "./buildchain-publication-authority": { group: "release-passport-trust", summary: "Buildchain-owned closed-world publication authority descriptor registry." },
    "./artifact-passport": { group: "release-passport-trust", summary: "Artifact passport digest and evidence helper APIs." },
    "./release-passport": { group: "release-passport-trust", summary: "Release passport collection, verification, explanation, and evidence APIs." },
    "./release-candidate": { group: "reusable-build", summary: "PR-stage release-candidate artifact, passport, and promote-only resolver APIs." },
    "./stable-candidate-ledger": { group: "governance-versioning", summary: "Immutable alpha candidate ledger, qualification, revocation, selection, and exact stable source-lock APIs." },
    "./release-propagation": { group: "site-and-propagation", summary: "Release propagation graph, plan, and exact upstream lock APIs." },
    "./release-line-bootstrap": { group: "governance-versioning", summary: "Semver release-line bootstrap planning and version-state APIs." },
    "./buildchain-contract": { group: "governance-versioning", summary: "Runtime contract world and compatibility digest APIs for floating-ref drift checks." },
    "./controller-evidence": { group: "reusable-build", summary: "Project-independent controller descriptors, source/runtime-bound plans, receipts, aggregates, and validation APIs." },
    "./surface-manifest": { group: "site-and-propagation", summary: "Surface manifest timestamp and reproducibility policy APIs." },
    "./issue-reporting": { group: "observability-diagnostics", summary: "Buildchain-owned issue reporting API for workflow friction feedback." },
    "./buildchain-layout": { group: "kfd-trust", summary: "Versioned Buildchain repository-layout discovery contract plus canonical .buildchain path resolution and migration APIs." },
    "./kfd": { group: "kfd-trust", summary: "Unified KFD standards, schema discovery, KFD-1/KFD-2/KFD-3 grouped APIs, KFD-4 schema discovery, upstream KFD aggregate facts, and Buildchain KFD claim helpers." },
    "./public-surface-audit": { group: "kfd-trust", summary: "Reverse audit APIs for CLI, workflow, action, site page, and documentation command surfaces." },
    "./kfd-gate": { group: "kfd-trust", summary: "KFD-1/KFD-2/KFD-3 release gate evidence and validation APIs." },
    "./kfd7-release-gate": { group: "kfd-trust", summary: "KFD-7 engineering-contract declaration, evidence closure, and release gate validation APIs." },
    "./buildchain-kfd-claims": { group: "kfd-trust", summary: "Buildchain self KFD claim registry, witnesses, and public claim APIs." },
  }));
  const meta = map.get(exportName);
  if (!meta) {
    throw new Error(`missing Node API capability metadata: ${exportName}`);
  }
  return { capabilityGroup: capabilityGroup(meta.group), summary: meta.summary, audience: ["developer", "agent"], maturity: "stable" };
}

function buildCapabilityRegistry({ docs, pages, cliRegistry, manualRegistry, nodeApiRegistry, workflowRegistry }) {
  const groupCounts = new Map(CAPABILITY_GROUPS.map((group) => [group.id, {
    manualCount: 0,
    pageCount: 0,
    cliCommandCount: 0,
    nodeApiCount: 0,
    workflowCount: 0,
    actionCount: 0,
  }]));
  for (const entry of manualRegistry.manuals) groupCounts.get(entry.capabilityGroup).manualCount += 1;
  for (const entry of pages) groupCounts.get(entry.capabilityGroup).pageCount += 1;
  for (const entry of cliRegistry.commands) groupCounts.get(entry.capabilityGroup).cliCommandCount += 1;
  for (const entry of nodeApiRegistry.exports) groupCounts.get(entry.capabilityGroup).nodeApiCount += 1;
  for (const entry of workflowRegistry.workflows) {
    const group = workflowCapabilityGroup(entry);
    groupCounts.get(group).workflowCount += 1;
  }
  for (const entry of workflowRegistry.actions) {
    const group = actionCapabilityGroup(entry.id);
    groupCounts.get(group).actionCount += 1;
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-capability-registry",
    package: readJson("package.json").name,
    sourceOfTruth: "npm package @kungfu-tech/buildchain/dist/site/capability-registry.json",
    groups: CAPABILITY_GROUPS.map((group) => ({
      ...group,
      counts: groupCounts.get(group.id),
      manuals: docs.filter((entry) => manualMeta(entry.id).capabilityGroup === group.id).map((entry) => entry.path),
      factSources: [
        "page-registry.json",
        "manual-registry.json",
        "cli-registry.json",
        "node-api-registry.json",
        "workflow-registry.json",
        "publication-registry.json",
        "kfd-upstream-aggregate.json",
        "kfd-claims.json",
      ],
    })),
    navigationPolicy: {
      defaultOrder: CAPABILITY_GROUPS.map((group) => group.id),
      rule: "Render Buildchain documentation by capability group first, then by manual order or command/API registry within the selected group.",
    },
  };
}

function workflowCapabilityGroup(entry) {
  if (["web-surface", "release-propagation"].includes(entry.id)) return capabilityGroup("site-and-propagation");
  if (["build", "release-candidate-promote", "publication-artifact", "paper-release"].includes(entry.id)) return capabilityGroup("reusable-build");
  if (["buildchain-ref-promotion", "release-line-bootstrap"].includes(entry.id)) return capabilityGroup("release-passport-trust");
  if (entry.id.includes("patrol") || entry.id.includes("dev-pr-auto-merge")) return capabilityGroup("governance-versioning");
  if (entry.status === "repository-internal" || entry.status === "compatibility-fixture") return capabilityGroup("api-cli-reference");
  return capabilityGroup("api-cli-reference");
}

function actionCapabilityGroup(id) {
  if (id === "promote-buildchain-ref") return capabilityGroup("release-passport-trust");
  if (id === "run-lifecycle" || id === "validate-config") return capabilityGroup("reusable-build");
  if (id === "report-buildchain-issue") return capabilityGroup("observability-diagnostics");
  return capabilityGroup("api-cli-reference");
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

function createPublicationReleaseRegistry({ packageJson, timestampPolicy }) {
  return {
    schemaVersion: 1,
    contract: PUBLICATION_RELEASE_REGISTRY_CONTRACT,
    ...timestampPolicy,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      versionSource: "package.json#version",
    },
    sourceKind: "package-site-bundle",
    sourceBoundary: {
      truthOwner: "@kungfu-tech/buildchain",
      siteRole: "rendering, routing, archive preservation checks, and agent discovery",
      rule: "Downstream papers sites render this registry; Buildchain owns publication route, latest, immutable artifact, passport, and source bundle facts.",
    },
    archivePolicy: {
      contract: "kungfu-buildchain-publication-archive-policy",
      mutableRouteKinds: [
        "canonical-reader",
        "latest",
        "registry-index",
      ],
      immutableRouteKinds: [
        "version-artifact",
        "version-passport",
        "version-source",
      ],
      deploymentBoundary: "append-only immutable version prefixes",
      rule: "A site build may update latest and canonical reader pages, but it must not delete or overwrite files under a declared immutable version prefix.",
    },
    publications: [
      {
        id: "publication-archive-fixture",
        title: "Publication Archive Fixture",
        summary: "A paper-shaped Buildchain package fact proving that site rendering preserves immutable versioned PDF, source, and passport routes while latest pages can move.",
        canonicalReader: {
          kind: "canonical-reader",
          url: "https://kungfu.tech/whitepaper/",
          owner: "site-kungfu-tech",
        },
        latest: {
          kind: "latest",
          version: "0.1.0",
          path: "/publication-archive-fixture/latest/",
        },
        immutablePrefixTemplate: "/publication-archive-fixture/v{version}/",
        versions: [
          {
            version: "0.1.0",
            releasedAt: "2026-07-09T00:00:00.000Z",
            immutable: true,
            immutablePath: "/publication-archive-fixture/v0.1.0/",
            source: {
              repository: "https://github.com/kungfu-systems/publication-archive-fixture",
              tag: "v0.1.0",
              commit: "0000000000000000000000000000000000000000",
              bundle: {
                path: "source.tar.gz",
                sha256: "sha256:e2ca891dbf441f867ed135b21b3556ee5cdcd3ec80038f267a3ecff496c5a38b",
                fixtureBodyBase64: "c2l0ZS1saWJrdW5nZnUtZGV2IHB1YmxpY2F0aW9uIGFyY2hpdmUgZml4dHVyZSBzb3VyY2UgYnVuZGxlCnZlcnNpb246IDAuMS4wCg==",
              },
            },
            passport: {
              path: "publication-artifact-passport.json",
              sha256: "sha256:ca214e2e17c8d3c01565e507e57d5b440943c762199aa8d9de21995940538cea",
              fixtureBodyBase64: "ewogICJjb250cmFjdCI6ICJrdW5nZnUtYnVpbGRjaGFpbi1wdWJsaWNhdGlvbi1hcnRpZmFjdC1wYXNzcG9ydCIsCiAgInB1YmxpY2F0aW9uIjogInB1YmxpY2F0aW9uLWFyY2hpdmUtZml4dHVyZSIsCiAgInZlcnNpb24iOiAiMC4xLjAiLAogICJzdGF0dXMiOiAiZml4dHVyZSIKfQo=",
            },
            artifacts: [
              {
                role: "pdf",
                path: "main.pdf",
                mediaType: "application/pdf",
                sha256: "sha256:c1c2020cbdcf0cc339323d2276480a48d9b8d7da9be1d19ab58a0b3c0b7a4fbb",
                fixtureBodyBase64: "JVBERi0xLjQKJSBzaXRlLWxpYmt1bmdmdS1kZXYgcHVibGljYXRpb24gYXJjaGl2ZSBmaXh0dXJlCjEgMCBvYmogPDwgL1R5cGUgL0NhdGFsb2cgL1BhZ2VzIDIgMCBSID4+IGVuZG9iagoyIDAgb2JqIDw8IC9UeXBlIC9QYWdlcyAvS2lkcyBbMyAwIFJdIC9Db3VudCAxID4+IGVuZG9iagozIDAgb2JqIDw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgMzAwIDE0NF0gL0NvbnRlbnRzIDQgMCBSID4+IGVuZG9iago0IDAgb2JqIDw8IC9MZW5ndGggNzIgPj4gc3RyZWFtCkJUIC9GMSAxMiBUZiAzNiAxMDAgVGQgKFB1YmxpY2F0aW9uIGFyY2hpdmUgZml4dHVyZSB2MC4xLjApIFRqIEVUCmVuZHN0cmVhbSBlbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAp0cmFpbGVyIDw8IC9Sb290IDEgMCBSIC9TaXplIDUgPj4Kc3RhcnR4cmVmCjM2MAolJUVPRgo=",
              },
            ],
          },
        ],
      },
    ],
  };
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
    commandSource: "bin/buildchain.mjs reverse enumeration",
    commands: enumerateCliCommandsFromBin({ root }).map((entry) => {
      const meta = cliCommandMeta(entry.id);
      return {
        ...entry,
        purpose: meta.purpose,
        capabilityGroup: meta.capabilityGroup,
        audience: meta.audience,
        maturity: meta.maturity,
      };
    }),
  };

  const manualRegistry = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-agent-manual-registry",
    package: packageJson.name,
    source: "npm package docs/",
    manuals: docs.map((entry) => {
      const meta = manualMeta(entry.id);
      return {
        id: entry.id,
        title: entry.title,
        path: entry.path,
        plane: entry.plane,
        digest: entry.digest,
        capabilityGroup: meta.capabilityGroup,
        audience: meta.audience,
        maturity: meta.maturity,
        order: meta.order,
      };
    }),
    requiredAgentManuals: [
      "docs/MAP.md",
      "docs/install.md",
      "docs/cli.md",
      "docs/build-facts.md",
      "docs/kfd-support.md",
      "docs/reusable-build-surface.md",
      "docs/release-candidate.md",
      "docs/stable-candidate-patrol.md",
      "docs/release-governance.md",
      "docs/release-passport.md",
      "docs/controller-evidence.md",
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
    capabilityGroups: CAPABILITY_GROUPS.map((group) => group.id),
    pages,
  };

  const nodeApiRegistry = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-node-api-registry",
    package: packageJson.name,
    moduleSystem: packageJson.type || "module",
    exports: Object.entries(packageJson.exports || {})
      .filter(([specifier]) => !specifier.startsWith("./site/") && specifier !== "./package.json")
      .map(([specifier, target]) => {
        const meta = nodeApiMeta(specifier);
        return {
          specifier: specifier === "." ? packageJson.name : `${packageJson.name}/${specifier.replace(/^\.\//, "")}`,
          export: specifier,
          target,
          digest: typeof target === "string" ? sha256File(target.replace(/^\.\//, "")) : "",
          summary: meta.summary,
          capabilityGroup: meta.capabilityGroup,
          audience: meta.audience,
          maturity: meta.maturity,
        };
      }),
    docs: [
      { id: "cli-and-node-package", path: "docs/cli.md", digest: sha256File("docs/cli.md") },
      { id: "build-facts", path: "docs/build-facts.md", digest: sha256File("docs/build-facts.md") },
      { id: "kfd-support", path: "docs/kfd-support.md", digest: sha256File("docs/kfd-support.md") },
      { id: "readme-badges", path: "docs/readme-badges.md", digest: sha256File("docs/readme-badges.md") },
      { id: "homebrew", path: "docs/homebrew.md", digest: sha256File("docs/homebrew.md") },
      { id: "site-bundle-contract", path: "docs/site-bundle-contract.md", digest: sha256File("docs/site-bundle-contract.md") },
    ],
    guidance: "These are the public Node import surfaces shipped by the npm package. Agents should prefer these exports over internal file paths.",
  };

  const workflowRegistry = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-workflow-registry",
    workflowSource: ".github/workflows reverse input enumeration",
    workflows: enumerateWorkflowInputs({ root }).map((entry) => {
      const surfaceById = new Map([
        ["build", "channel-build-router"],
        [".build", "reusable-build"],
        ["web-surface", "site-app-deployment"],
        ["buildchain-ref-promotion", "release-governance"],
        ["release-line-bootstrap", "release-governance"],
        ["release-candidate-promote", "release-governance"],
        ["paper-release", "reusable-build"],
        ["release-propagation", "release-propagation"],
        ["dev-pr-auto-merge", "dev-governance"],
        ["binary-distribution", "release-passport"],
        ["buildchain-patrol", "repository-patrol"],
        ["buildchain-patrol-daily", "repository-patrol"],
        ["buildchain-patrol-weekly", "repository-patrol"],
        ["buildchain-patrol-monthly", "repository-patrol"],
        ["stable-candidate-patrol", "repository-patrol"],
        ["buildchain-stable-candidate-patrol", "repository-patrol"],
        ["buildchain-stable-candidate-qualification", "repository-patrol"],
        ["patrol-daily", "repository-patrol"],
        ["patrol-weekly", "repository-patrol"],
        ["patrol-monthly", "repository-patrol"],
      ]);
      const statusById = new Map([
        ["release-propagation", "preview"],
        ["candidate-lab", "repository-internal"],
        ["build-surface-fixture", "repository-internal"],
        ["buildchain-stable-candidate-qualification", "repository-internal"],
        ["self-hosted-runner-smoke", "compatibility-fixture"],
      ]);
      return {
        ...entry,
        surface: surfaceById.get(entry.id) || (entry.path.includes("/.") ? "reusable-workflow" : "repository-workflow"),
        capabilityGroup: workflowCapabilityGroup({
          ...entry,
          status: statusById.get(entry.id) || "active",
        }),
        status: statusById.get(entry.id) || "active",
      };
    }),
    actionSource: "actions/*/action.yml reverse input enumeration",
    actions: enumerateActionInputs({ root }).map((entry) => ({
      ...entry,
      capabilityGroup: actionCapabilityGroup(entry.id),
      status: "active",
    })),
  };
  const controllerRegistry = createControllerRegistry({ workflows: workflowRegistry.workflows });
  const publicationAuthorityRegistry = createBuildchainPublicationAuthorityRegistry({ root });
  const publicSurfaceAudit = collectPublicSurfaceReverseAudit({
    root,
    cliRegistry,
    workflowRegistry,
    pageRegistry,
  });
  const capabilityRegistry = buildCapabilityRegistry({
    docs,
    pages,
    cliRegistry,
    manualRegistry,
    nodeApiRegistry,
    workflowRegistry,
  });

  const releaseModel = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-model",
    exactTags: "v-prefixed exact tags are immutable release records.",
    floatingTags: "vX, vX-alpha, vX.Y, and vX.Y-alpha are channel pointers updated by Buildchain transactions; vX-alpha follows the highest minor in major X with a published alpha.",
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
      "badge-endpoint-registry.json",
      "publication-registry.json",
      "page-registry.json",
      "capability-registry.json",
      "cli-registry.json",
      "manual-registry.json",
      "node-api-registry.json",
      "workflow-registry.json",
      "controller-registry.json",
      "publication-authority-registry.json",
      "public-surface-audit.json",
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
      "capability-registry.json",
      "cli-registry.json",
      "manual-registry.json",
      "node-api-registry.json",
      "workflow-registry.json",
      "controller-registry.json",
      "publication-authority-registry.json",
      "public-surface-audit.json",
      "release-model.json",
      "artifact-schemas.json",
      "badge-endpoint-registry.json",
      "publication-registry.json",
      "product-mechanism.json",
      "release-provenance.json",
      "kfd-upstream-aggregate.json",
      "kfd-claims.json",
      "agent-index.json",
    ],
  };

  const agentIndex = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-site-agent-index",
    readOrder: [
      "site-manifest.json",
      "capability-registry.json",
      "page-registry.json",
      "product-mechanism.json",
      "release-model.json",
      "cli-registry.json",
      "manual-registry.json",
      "node-api-registry.json",
      "workflow-registry.json",
      "controller-registry.json",
      "publication-authority-registry.json",
      "public-surface-audit.json",
      "artifact-schemas.json",
      "buildchain-contract.json",
      "kfd-upstream-aggregate.json",
      "kfd-claims.json",
      "badge-endpoint-registry.json",
      "publication-registry.json",
    ],
    instruction: "Use this bundle as the package-owned fact source for Buildchain pages. Do not infer current release mechanics from prose alone.",
  };
  const badgeEndpointRegistry = createReadmeBadgeEndpointRegistry({
    kfdStandards: readPackageKfdStandards(),
  });
  const publicationRegistry = createPublicationReleaseRegistry({ packageJson, timestampPolicy });

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
    capabilityRegistry: {
      path: "capability-registry.json",
      contract: capabilityRegistry.contract,
      groupCount: capabilityRegistry.groups.length,
      defaultOrder: capabilityRegistry.navigationPolicy.defaultOrder,
    },
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
        "capability-grouped navigation registry for docs, CLI, Node API, workflows, actions, and KFD claims",
        "release model facts",
        "workflow and action registries",
        "controller evidence descriptors and input classification",
        "CLI command registry",
        "public surface reverse audit",
        "manual and Node API registries",
        "KFD claim registry",
        "KFD upstream aggregate registry",
        "release-passport evidence vocabulary",
        "publication archive registry and immutable papers surface facts",
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
    "capability-registry.json": capabilityRegistry,
    "cli-registry.json": cliRegistry,
    "manual-registry.json": manualRegistry,
    "node-api-registry.json": nodeApiRegistry,
    "workflow-registry.json": workflowRegistry,
    "controller-registry.json": controllerRegistry,
    "publication-authority-registry.json": publicationAuthorityRegistry,
    "public-surface-audit.json": publicSurfaceAudit,
    "release-model.json": releaseModel,
    "artifact-schemas.json": artifactSchemas,
    "badge-endpoint-registry.json": badgeEndpointRegistry,
    "publication-registry.json": publicationRegistry,
    "buildchain-contract.json": createBuildchainContractWorld({ root, controllerRegistry }),
    "kfd-upstream-aggregate.json": collectKfdUpstreamFacts({ cwd: root, includeOwn: false }),
    "kfd-claims.json": createBuildchainKfdClaimRegistry({ root }),
    "product-mechanism.json": productMechanism,
    "release-provenance.json": releaseProvenance,
    "agent-index.json": agentIndex,
    ...Object.fromEntries(badgeEndpointRegistry.badges.flatMap((badge) => (
      badge.states.map((state) => [state.path, state.payload])
    ))),
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
