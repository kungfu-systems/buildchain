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
import { KFD_AGENT_HUB_ADOPTION_SCHEMA } from "../packages/core/kfd-agent-hub.js";
import {
  KFD_PRODUCT_GATE_INPUT_SCHEMA,
  KFD_SUPPORT_PROJECTION_SCHEMA,
} from "../packages/core/kfd-product-gates.js";
import {
  createReadmeBadgeEndpointRegistry,
} from "../packages/core/readme-badges.js";
import {
  RELEASE_PASSPORT_SCHEMA,
  createReleasePassportCheckManifest,
} from "../packages/core/release-passport-contract.js";
import {
  collectPublicSurfaceReverseAudit,
  enumerateActionInputs,
  enumerateCliCommandsFromBin,
  enumerateWorkflowInputs,
} from "../packages/core/public-surface-audit.js";
import { createSurfaceTimestampPolicy } from "../packages/core/surface-manifest.js";
import { cliCommandMeta, nodeApiMeta } from "./site-capability-metadata.mjs";
import { projectHomepageIntro } from "./site-bundle-homepage.mjs";
import { BUILDCHAIN_USAGE } from "./buildchain-cli-help.mjs";
import {
  cliReferenceById,
  createCliReference,
} from "./public-reference.mjs";
import { createSiteNodeApiRegistry } from "./site-reference-registry.mjs";
import {
  BUILDCHAIN_COMMAND_REGISTRY,
  resolveBuildchainCommand,
} from "../bin/internal/command-registry.mjs";

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

function publicSurfaceLifecycle({ owner, maturity, nonDuplicationRationale }) {
  return {
    owner,
    maturity,
    introducedVersion: "pre-3.0.2-alpha.4",
    compatibilityPromise: "preserved-through-the-v3-major-line",
    deprecationReplacement: "",
    sunsetCondition: "explicit-breaking-change-review-in-a-future-major-line",
    nonDuplicationRationale,
  };
}

const manualMetaById = new Map(Object.entries({
  map: { capabilityGroup: "getting-started", audience: ["agent", "consumer"], maturity: "stable", order: 10 },
  "getting-started": { capabilityGroup: "getting-started", audience: ["consumer", "agent"], maturity: "stable", order: 15 },
  install: { capabilityGroup: "getting-started", audience: ["consumer"], maturity: "stable", order: 20 },
  "product-mechanism": { capabilityGroup: "getting-started", audience: ["agent", "maintainer"], maturity: "stable", order: 30 },
  cli: { capabilityGroup: "api-cli-reference", audience: ["agent", "developer"], maturity: "stable", order: 40 },
  "cli-reference": { capabilityGroup: "api-cli-reference", audience: ["agent", "developer", "operator"], maturity: "stable", order: 42 },
  "node-api-reference": { capabilityGroup: "api-cli-reference", audience: ["agent", "developer"], maturity: "stable", order: 44 },
  "release-passport": { capabilityGroup: "release-passport-trust", audience: ["release-operator", "agent"], maturity: "stable", order: 100 },
  "github-artifact-attestation": { capabilityGroup: "release-passport-trust", audience: ["release-operator", "agent"], maturity: "preview", order: 108 },
  "publication-authority": { capabilityGroup: "release-passport-trust", audience: ["release-operator", "agent"], maturity: "preview", order: 105 },
  "github-governance-authority": { capabilityGroup: "governance-versioning", audience: ["maintainer", "release-operator", "agent"], maturity: "preview", order: 106 },
  "controller-evidence": { capabilityGroup: "reusable-build", audience: ["consumer", "release-operator", "agent"], maturity: "draft", order: 205 },
  "auditable-demo": { capabilityGroup: "reusable-build", audience: ["consumer", "agent"], maturity: "preview", order: 207 },
  "binary-distribution": { capabilityGroup: "release-passport-trust", audience: ["release-operator", "agent"], maturity: "stable", order: 110 },
  "publish-transaction": { capabilityGroup: "release-passport-trust", audience: ["release-operator"], maturity: "stable", order: 120 },
  "release-tail-contract": { capabilityGroup: "release-passport-trust", audience: ["release-operator", "agent", "maintainer"], maturity: "draft", order: 122 },
  "release-activation-transaction": { capabilityGroup: "release-passport-trust", audience: ["release-operator", "agent"], maturity: "preview", order: 125 },
  "release-candidate": { capabilityGroup: "reusable-build", audience: ["release-operator", "consumer"], maturity: "stable", order: 130 },
  "stable-candidate-patrol": { capabilityGroup: "governance-versioning", audience: ["release-operator", "consumer"], maturity: "preview", order: 135 },
  "dev-qualification-patrol": { capabilityGroup: "governance-versioning", audience: ["release-operator", "consumer", "agent"], maturity: "preview", order: 136 },
  "dev-alpha-candidate-patrol": { capabilityGroup: "governance-versioning", audience: ["release-operator", "consumer", "agent"], maturity: "preview", order: 137 },
  "observed-evidence-patrol": { capabilityGroup: "governance-versioning", audience: ["release-operator", "consumer", "agent"], maturity: "preview", order: 140 },
  "reusable-build-surface": { capabilityGroup: "reusable-build", audience: ["consumer", "release-operator"], maturity: "stable", order: 200 },
  "lifecycle-protocol": { capabilityGroup: "reusable-build", audience: ["consumer", "developer"], maturity: "stable", order: 210 },
  "runtime-train-validation": { capabilityGroup: "governance-versioning", audience: ["maintainer", "consumer"], maturity: "stable", order: 220 },
  "kfd-support": { capabilityGroup: "kfd-trust", audience: ["agent", "maintainer"], maturity: "stable", order: 300 },
  "kfd-agent-hub": { capabilityGroup: "kfd-trust", audience: ["agent", "consumer", "maintainer"], maturity: "preview", order: 305 },
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

function createCliRegistry(packageJson) {
  const commands = enumerateCliCommandsFromBin({ root });
  const reference = createCliReference(BUILDCHAIN_USAGE);
  const referenceById = cliReferenceById(reference);
  const documentedTopLevelCommands = new Set();
  for (const entry of commands) {
    const command = entry.usage.split(/\s+/)[1] || "";
    const registration = resolveBuildchainCommand(command);
    if (!registration) {
      throw new Error(`CLI help documents an unregistered top-level command: ${command}`);
    }
    documentedTopLevelCommands.add(registration.id);
  }
  for (const entry of BUILDCHAIN_COMMAND_REGISTRY) {
    if (!documentedTopLevelCommands.has(entry.id)) {
      throw new Error(`CLI runtime command is absent from help enumeration: ${entry.id}`);
    }
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-cli-registry",
    binary: "buildchain",
    npmPackage: packageJson.name,
    commandSource: "bin/internal/command-registry.mjs plus bin/buildchain.mjs help enumeration",
    commands: commands.map((entry) => {
      const meta = cliCommandMeta(entry.id);
      return {
        ...entry,
        ...(referenceById.get(entry.id) || {
          paths: [],
          syntaxes: [],
          options: [],
          aliases: [],
          helpCommands: [],
        }),
        purpose: meta.purpose,
        capabilityGroup: meta.capabilityGroup,
        audience: meta.audience,
        ...publicSurfaceLifecycle({
          owner: "buildchain-cli",
          maturity: meta.maturity,
          nonDuplicationRationale: "Existing command identity retained for CLI compatibility and discoverability.",
        }),
      };
    }),
  };
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
  if (entry.id === "github-artifact-attestation") return capabilityGroup("release-passport-trust");
  if (["web-surface", "release-propagation"].includes(entry.id)) return capabilityGroup("site-and-propagation");
  if (["build", "release-candidate-promote", "publication-artifact", "paper-release"].includes(entry.id)) return capabilityGroup("reusable-build");
  if (["buildchain-ref-promotion", "release-line-bootstrap"].includes(entry.id)) return capabilityGroup("release-passport-trust");
  if (entry.id.includes("patrol") || entry.id.includes("dev-pr-auto-merge") || entry.id.includes("dev-delivery-warrant") || entry.id.includes("buildchain-dev-delivery")) return capabilityGroup("governance-versioning");
  if (entry.status === "repository-internal" || entry.status === "compatibility-fixture") return capabilityGroup("api-cli-reference");
  return capabilityGroup("api-cli-reference");
}

function actionCapabilityGroup(id) {
  if (id === "github-artifact-attestation") return capabilityGroup("release-passport-trust");
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

const RELEASE_PROPAGATION_MODEL = {
  graphContract: "kungfu-buildchain-release-propagation-graph",
  planContract: "kungfu-buildchain-release-propagation-plan",
  lockContract: "kungfu-buildchain-release-propagation-lock",
  workContract: "kungfu-buildchain-release-propagation-work",
  stageReceiptContract: "kungfu-buildchain-release-propagation-stage-receipt",
  workControlBindings: [
    "kungfu.assignment-graph.work-ref/v1",
    "kungfu.work-control.initiative-family-state/v2",
  ],
  completionBoundary: "production-online-readback-plus-accepted-work-control-decision",
  defaultChannelPolicy: "preserve",
  defaultChannelMap: { alpha: "alpha", release: "release" },
};

function buildSiteBundle() {
  const packageJson = readJson("package.json");
  const inventory = readJson("tests/buildchain-inventory.json");
  const readme = parseReadme(readText(README_PATH));
  const homepageIntro = projectHomepageIntro(readme.intro);
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

  const cliRegistry = createCliRegistry(packageJson);

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
      "docs/dev-qualification-patrol.md",
      "docs/dev-alpha-candidate-patrol.md",
      "docs/observed-evidence-patrol.md",
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

  const nodeApiRegistry = createSiteNodeApiRegistry({ root, packageJson, nodeApiMeta, sha256File, publicSurfaceLifecycle });

  const workflowRegistry = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-workflow-registry",
    workflowSource: ".github/workflows reverse input enumeration",
    workflows: enumerateWorkflowInputs({ root }).map((entry) => {
      const surfaceById = new Map([
        ["build", "channel-build-router"],
        [".build", "reusable-build"],
        [".auditable-demo", "auditable-demo"],
        [".declarative-auditable-demo", "declarative-auditable-demo"],
        ["web-surface", "site-app-deployment"],
        ["buildchain-ref-promotion", "release-governance"],
        ["release-line-bootstrap", "release-governance"],
        ["release-governance-reconcile", "release-governance"],
        ["release-candidate-promote", "release-governance"],
        ["paper-release", "reusable-build"],
        ["release-propagation", "release-propagation"],
        ["dev-pr-auto-merge", "dev-governance"],
        ["buildchain-dev-delivery", "dev-governance"],
        ["github-governance-audit", "dev-governance"],
        ["binary-distribution", "release-passport"],
        ["github-artifact-attestation", "release-passport"],
        ["buildchain-patrol", "repository-patrol"],
        ["buildchain-patrol-daily", "repository-patrol"],
        ["buildchain-patrol-weekly", "repository-patrol"],
        ["buildchain-patrol-monthly", "repository-patrol"],
        ["stable-candidate-patrol", "repository-patrol"],
        ["dev-qualification-patrol", "repository-patrol"],
        ["dev-alpha-candidate-patrol", "repository-patrol"],
        ["buildchain-stable-candidate-patrol", "repository-patrol"],
        ["buildchain-stable-candidate-qualification", "repository-patrol"],
        ["patrol-daily", "repository-patrol"],
        ["patrol-weekly", "repository-patrol"],
        ["patrol-monthly", "repository-patrol"],
        ["patrol-observed-evidence", "repository-patrol"],
      ]);
      const statusById = new Map([
        [".auditable-demo", "preview"],
        [".declarative-auditable-demo", "preview"],
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
        ...publicSurfaceLifecycle({
          owner: "buildchain-workflows",
          maturity: statusById.get(entry.id) || "active",
          nonDuplicationRationale: "Existing workflow identity retained for caller compatibility and repository orchestration.",
        }),
      };
    }),
    actionSource: "actions/*/action.yml reverse input enumeration",
    actions: enumerateActionInputs({ root }).map((entry) => ({
      ...entry,
      capabilityGroup: actionCapabilityGroup(entry.id),
      status: "active",
      ...publicSurfaceLifecycle({
        owner: "buildchain-actions",
        maturity: "stable",
        nonDuplicationRationale: "Existing action identity retained as the canonical composite or JavaScript action boundary.",
      }),
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
      schema: "schemas/release-passport-v1.schema.json",
      checkManifest: "release-passport-check-manifest.json",
    },
    releasePropagation: RELEASE_PROPAGATION_MODEL,
    npm: {
      package: packageJson.name,
      command: packageJson.bin?.buildchain || "",
      versionSource: "package.json#version",
      alphaDistTag: "alpha",
      stableDistTag: "latest",
    },
    githubRelease: {
      exactTagRelease: true,
      authoritativeIntent: "Buildchain publication channel controls prerelease/latest metadata when available",
      alphaChannel: "alpha publication sets prerelease=true and make_latest=false",
      stableChannels: "release, stable, and major publication set prerelease=false and make_latest=true",
      tagFallback: "ordinary callers without publication intent use semver prerelease syntax",
      evidenceAssets: [
        "publish evidence JSON",
        "buildchain.release.json",
        "release passport assets",
        "GitHub artifact attestation Sigstore bundle and Buildchain evidence JSON",
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
      "release-passport-check-manifest.json",
      "schemas/release-passport-v1.schema.json",
      "schemas/kfd-agent-hub-adoption.schema.json",
      "schemas/kfd-product-gate-input-v1.schema.json",
      "schemas/kfd-support-projection-v1.schema.json",
      "kfd-support.json",
      "artifact-evidence.json",
      "product-mechanism.json",
      "impact.json",
      "agent-index.json",
      "check-report.json",
      "llms.txt",
      "buildchain-release-bundle.json",
      "buildchain-release-bundle.tar.gz",
      "github-artifact-attestation.policy.json",
      "github-artifact-attestation.predicate.json",
      "github-artifact-attestation.evidence.json",
      "attestation.sigstore.json",
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
      "release-passport-check-manifest.json",
      "schemas/release-passport-v1.schema.json",
      "schemas/kfd-agent-hub-adoption.schema.json",
      "schemas/kfd-product-gate-input-v1.schema.json",
      "schemas/kfd-support-projection-v1.schema.json",
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
    agentSupplyChain: {
      layer: "buildchain",
      order: 2,
      owner: "Buildchain",
      input: "KFD-3-discoverable product declarations and an exact source cut",
      output: "artifact-bound provenance, checks, and promotion evidence",
      statusClass: "proved-now",
      publicStatement: "Buildchain proves consistency between product-owned declarations and exact release artifacts, and fails or downgrades when evidence drifts.",
      downstream: "KFD-2 purpose-bound assessment and receiver-owned admission",
      evidence: ["buildchain.release.json", "artifact-evidence.json", "product-mechanism.json"],
      knownLimits: [
        "Buildchain does not create product facts or make the receiver's trust decision.",
        "A passing passport is exact-artifact evidence, not blanket certification or adoption proof.",
      ],
      humanRoute: "https://buildchain.libkungfu.dev/",
      agentRoute: "https://buildchain.libkungfu.dev/manifest.json",
    },
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
      "release-passport-check-manifest.json",
      "schemas/release-passport-v1.schema.json",
      "schemas/kfd-agent-hub-adoption.schema.json",
      "schemas/kfd-product-gate-input-v1.schema.json",
      "schemas/kfd-support-projection-v1.schema.json",
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
      lead: homepageIntro.lead,
      mechanismSummary: homepageIntro.mechanismSummary,
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
    "release-passport-check-manifest.json": createReleasePassportCheckManifest(),
    "schemas/release-passport-v1.schema.json": RELEASE_PASSPORT_SCHEMA,
    "schemas/kfd-agent-hub-adoption.schema.json": KFD_AGENT_HUB_ADOPTION_SCHEMA,
    "schemas/kfd-product-gate-input-v1.schema.json": KFD_PRODUCT_GATE_INPUT_SCHEMA,
    "schemas/kfd-support-projection-v1.schema.json": KFD_SUPPORT_PROJECTION_SCHEMA,
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
