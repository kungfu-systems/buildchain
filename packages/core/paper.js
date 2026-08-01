import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateBuildchainConfig } from "./buildchain-config.js";
import {
  createBuildchainContractLock,
  createBuildchainContractWorld,
  evaluateBuildchainContractLock,
  readBuildchainContractLock,
} from "./buildchain-contract.js";
import {
  releaseTransactionPublicationState,
  readReleaseTransaction,
} from "./publish-transaction.js";
import { PUBLICATION_REPRODUCIBILITY_RECEIPT_CONTRACT } from "./publication-reproducibility.js";
import {
  PUBLICATION_SEALED_BUNDLE_CONTRACT,
  verifyPublicationSealedBundle,
} from "./publication-sealed-bundle.js";
import {
  PAPER_PATHS,
  commandResult,
  gitResult,
  gitValue,
  normalizeRepository,
  paperConfig,
  parsePaperVersion,
  readJson,
  resolvePaperRepository,
  sha256Text,
  stableJson,
} from "./paper-repository.js";
import {
  PAPER_AGENT_ENTRY_CONTRACT,
  collectPaperAgentEntry,
  paperAgentEntryFiles,
  resolvePaperBuildchainSha,
} from "./paper-agent-entry.js";
import {
  managedPaperPackageJson,
  scaffoldMainTex,
  scaffoldMakefile,
  scaffoldMap,
  scaffoldPackageJson,
  scaffoldReadme,
} from "./paper-scaffold-content.js";
import { executePaperNpmBootstrap as executePaperNpmBootstrapOperation } from "./paper-npm-bootstrap.js";

export { PAPER_PATHS, resolvePaperRepository } from "./paper-repository.js";
export {
  PAPER_AGENT_ENTRY_CONTRACT,
  PAPER_AGENT_ENTRY_SCHEMA_VERSION,
  PAPER_AGENT_ENTRY_SECTION_END,
  PAPER_AGENT_ENTRY_SECTION_START,
  collectPaperAgentEntry,
  createPaperAgentEntry,
  mergePaperAgentEntryInstructions,
  paperAgentEntryFiles,
  paperAgentEntryInstructions,
  resolvePaperBuildchainSha,
} from "./paper-agent-entry.js";
export {
  PAPER_WORK_START_PLAN_CONTRACT,
  PAPER_WORK_SUBMIT_PLAN_CONTRACT,
  createPaperWorkStartPlan,
  createPaperWorkSubmitPlan,
  executePaperWorkStart,
  executePaperWorkSubmitPush,
} from "./paper-work.js";
export {
  PAPER_FLEET_AUDIT_CONTRACT,
  PAPER_FLEET_UPDATE_PLAN_CONTRACT,
  collectPaperFleetAudit,
  discoverPaperFleet,
  planPaperFleetUpdate,
  writePaperFleetUpdate,
} from "./paper-fleet.js";

export const PAPER_SCAFFOLD_CONTRACT = "kungfu-buildchain-paper-scaffold";
export const PAPER_MIGRATION_CONTRACT = "kungfu-buildchain-paper-migration";
export const PAPER_PREFLIGHT_CONTRACT = "kungfu-buildchain-paper-preflight";
export const PAPER_STATUS_CONTRACT = "kungfu-buildchain-paper-status";
export const PAPER_NPM_BOOTSTRAP_CONTRACT =
  "kungfu-buildchain-paper-npm-bootstrap";
export const PAPER_PROVISIONING_CONTRACT =
  "kungfu-buildchain-paper-provisioning-authority";
export const PAPER_BUILD_PLAN_CONTRACT = "kungfu-buildchain-paper-build-plan";
export const PAPER_ALPHA_PLAN_CONTRACT = "kungfu-buildchain-paper-alpha-plan";
export const PAPER_RESUME_PLAN_CONTRACT = "kungfu-buildchain-paper-resume-plan";
export const PAPER_VISIBILITY_CONTRACT = "kungfu-buildchain-paper-visibility";

export const PAPER_STATE_ORDER = Object.freeze([
  "scaffolded",
  "governed",
  "admitted",
  "bootstrapped",
  "trust-bound",
  "content-ready",
  "artifact-sealed",
  "package-published",
  "alpha-complete",
  "staging-visible",
  "production-visible",
]);

const PAPER_SCAFFOLD_PATHS = Object.freeze([
  PAPER_PATHS.config,
  PAPER_PATHS.agentEntry,
  PAPER_PATHS.agentInstructions,
  PAPER_PATHS.contractLock,
  PAPER_PATHS.versionPin,
  PAPER_PATHS.buildWorkflow,
  PAPER_PATHS.verifyWorkflow,
  PAPER_PATHS.releaseWorkflow,
  PAPER_PATHS.pnpmWorkspace,
  PAPER_PATHS.provisioningAuthority,
  "Makefile",
  "package.json",
  "README.md",
  "docs/MAP.md",
  "paper/main.tex",
  "paper/references.bib",
  "LICENSE",
  ".gitignore",
]);

const NPM_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";
const DEFAULT_TOOLCHAIN_IMAGE =
  "ghcr.io/kungfu-systems/build-images/latex-pdf-builder";
const DEFAULT_TOOLCHAIN_DIGEST =
  "sha256:c20f3809e96836c1c78e97c76939d12f1de3fed0ea9b7c40c43332ec2ea480f8";
const DEFAULT_TOOLCHAIN_COMMAND = "latexmk -pdf -outdir=_build paper/main.tex";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const BUILDCHAIN_PACKAGE_NAME = "@kungfu-tech/buildchain";

function toPosix(value) {
  return String(value || "")
    .split(path.sep)
    .join("/");
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function paperPnpmWorkspace(current, buildchainVersion) {
  const entry = `${BUILDCHAIN_PACKAGE_NAME}@${buildchainVersion}`;
  const source = String(current || "");
  const lines = source ? source.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const keyLines = lines
    .map((line, index) =>
      /^minimumReleaseAgeExclude:\s*(?:#.*)?$/.test(line) ? index : -1,
    )
    .filter((index) => index >= 0);
  const unsupportedKey = lines.some(
    (line) =>
      /^minimumReleaseAgeExclude\s*:/.test(line) &&
      !/^minimumReleaseAgeExclude:\s*(?:#.*)?$/.test(line),
  );
  if (unsupportedKey || keyLines.length > 1) {
    throw new Error(
      "paper migration requires minimumReleaseAgeExclude to be one top-level block sequence",
    );
  }
  if (keyLines.length === 0) {
    const prefix = lines.length > 0 ? [...lines, ""] : [];
    return `${[...prefix, "minimumReleaseAgeExclude:", `  - '${entry}'`].join(
      "\n",
    )}\n`;
  }
  const keyIndex = keyLines[0];
  let blockEnd = lines.length;
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    if (/^[^\s#]/.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }
  const retained = [];
  for (const line of lines.slice(keyIndex + 1, blockEnd)) {
    if (!line.trim() || /^\s*#/.test(line)) {
      retained.push(line);
      continue;
    }
    const item = line.match(/^\s*-\s+(.+?)\s*(?:#.*)?$/);
    if (!item) {
      throw new Error(
        "paper migration requires minimumReleaseAgeExclude to contain scalar package entries",
      );
    }
    const value = item[1]
      .trim()
      .replace(/^'(.*)'$/, "$1")
      .replace(/^"(.*)"$/, "$1");
    if (!value.startsWith(`${BUILDCHAIN_PACKAGE_NAME}@`)) retained.push(line);
  }
  return `${[
    ...lines.slice(0, keyIndex + 1),
    ...retained,
    `  - '${entry}'`,
    ...lines.slice(blockEnd),
  ].join("\n")}\n`;
}

function existingFileFact(cwd, relativePath) {
  const filePath = path.resolve(cwd, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined;
  }
  return {
    path: toPosix(relativePath),
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
  };
}

function normalizePackageName(value, label = "package name") {
  const normalized = String(value || "").trim();
  if (!PACKAGE_PATTERN.test(normalized) || normalized.length > 214) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function buildchainPackageIdentity(buildchainRoot, explicitVersion = "") {
  const packageJson = readJson(
    path.resolve(buildchainRoot, "package.json"),
  ).value;
  return {
    name: String(packageJson?.name || "@kungfu-tech/buildchain"),
    version: String(explicitVersion || packageJson?.version || ""),
  };
}

export function resolvePaperRuntimeGitSha(
  buildchainRoot,
  buildchainVersion = "",
) {
  const value = resolvePaperBuildchainSha(buildchainRoot);
  if (GIT_SHA_PATTERN.test(value)) return value;
  const identity = buildchainPackageIdentity(buildchainRoot, buildchainVersion);
  if (!identity.version) return "";
  const observed = commandResult(
    "npm",
    [
      "view",
      `${identity.name}@${identity.version}`,
      "gitHead",
      "--json",
      `--registry=${NPM_REGISTRY}`,
    ],
    { cwd: buildchainRoot },
  );
  if (!observed.ok) return "";
  const parsed = safeParseJson(observed.stdout);
  const gitHead =
    typeof parsed === "string" ? parsed : String(parsed?.gitHead || "");
  return GIT_SHA_PATTERN.test(gitHead) ? gitHead : "";
}

function runtimeAcceptedAt(buildchainRoot, sha, buildchainVersion = "") {
  if (!sha) return "1970-01-01T00:00:00.000Z";
  const value = gitValue(buildchainRoot, ["show", "-s", "--format=%cI", sha]);
  let acceptedAt = value;
  if (!acceptedAt && buildchainVersion) {
    const identity = buildchainPackageIdentity(
      buildchainRoot,
      buildchainVersion,
    );
    const observed = commandResult(
      "npm",
      [
        "view",
        `${identity.name}@${identity.version}`,
        "time",
        "--json",
        `--registry=${NPM_REGISTRY}`,
      ],
      { cwd: buildchainRoot },
    );
    const published = observed.ok ? safeParseJson(observed.stdout) : null;
    acceptedAt = String(published?.[identity.version] || "");
  }
  const parsed = new Date(acceptedAt);
  return Number.isNaN(parsed.valueOf())
    ? "1970-01-01T00:00:00.000Z"
    : parsed.toISOString();
}

function runtimeContractWorld(buildchainRoot) {
  const embedded = String(process.env.BUILDCHAIN_EMBEDDED_CONTRACT_WORLD || "");
  if (embedded) {
    const parsed = safeParseJson(embedded);
    if (parsed?.contract) return parsed;
    throw new Error("embedded Buildchain contract world is invalid");
  }
  return createBuildchainContractWorld({ root: buildchainRoot });
}

function runtimeLicenseText(buildchainRoot) {
  const licensePath = path.join(buildchainRoot, "LICENSE");
  if (fs.existsSync(licensePath) && fs.statSync(licensePath).isFile()) {
    return fs.readFileSync(licensePath, "utf8");
  }
  const embedded = String(process.env.BUILDCHAIN_EMBEDDED_LICENSE_TEXT || "");
  if (embedded) return embedded;
  throw new Error(
    "Buildchain package is missing LICENSE; cannot create a governed paper scaffold",
  );
}

function tomlString(value) {
  return JSON.stringify(String(value || ""));
}

function joinUrl(base, suffix = "") {
  const normalizedBase = String(base || "")
    .trim()
    .replace(/\/+$/, "");
  const normalizedSuffix = String(suffix || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!normalizedBase) return "";
  return normalizedSuffix
    ? `${normalizedBase}/${normalizedSuffix}/`
    : `${normalizedBase}/`;
}

function scaffoldConfig({ name, title, packageName, version, siteBaseUrl }) {
  const archiveId = name.replace(/^paper-/, "");
  const canonicalUrl = joinUrl(siteBaseUrl, archiveId);
  const archive = canonicalUrl
    ? `
[publication.archive]
id = ${tomlString(archiveId)}
canonical_url = ${tomlString(canonicalUrl)}
latest_url = ${tomlString(joinUrl(canonicalUrl, "latest"))}
latest_evidence_url = ${tomlString(`${joinUrl(canonicalUrl, "latest")}buildchain.release.json`)}
immutable_base_url = ${tomlString(joinUrl(siteBaseUrl, "archive").replace(/\/$/, ""))}
registry_path = ".buildchain/publication/publication-registry.json"
`
    : "";
  return `schema = 1

[project]
type = "publication-artifact"
name = ${tomlString(name)}

[publication]
kind = "paper"
title = ${tomlString(title)}
version = ${tomlString(version)}
primary_artifact = "_build/main.pdf"
artifact_paths = ["_build/main.pdf"]
metadata_paths = ["README.md", "docs/MAP.md"]
source_paths = ["paper", "README.md", "LICENSE", "Makefile"]
site_consumers = ${siteBaseUrl ? `[${tomlString(siteBaseUrl)}]` : "[]"}
manifest_path = ".buildchain/publication/publication-artifact.json"
source_bundle_path = ".buildchain/publication/source.tar.gz"
${archive}
[publication.toolchain]
type = "latex-docker"
image = "${DEFAULT_TOOLCHAIN_IMAGE}"
digest = "${DEFAULT_TOOLCHAIN_DIGEST}"
command = "${DEFAULT_TOOLCHAIN_COMMAND}"

[publish]
kind = "npm-paper-package"
package = ${tomlString(packageName)}
auth = "trusted-publishing"

[lifecycle.build]
command = "make pdf"

[lifecycle.verify]
command = "make check"
`;
}

function scaffoldBuildWorkflow(
  buildchainSha,
  { artifactName = "paper-publication" } = {},
) {
  return `name: Build

on:
  workflow_dispatch:
  pull_request:
  push:
    branches:
      - "dev/**"
      - "alpha/**"
      - "release/**"

permissions:
  contents: read
  issues: write

jobs:
  publication:
    uses: kungfu-systems/buildchain/.github/workflows/publication-artifact.yml@${buildchainSha}
    with:
      buildchain-ref: ${buildchainSha}
      buildchain-contract-lock-path: .buildchain/contract-lock.json
      toolchain-type: config
      verify-command: make check
      artifact-name: ${JSON.stringify(artifactName)}
`;
}

function scaffoldVerifyWorkflow(buildchainSha) {
  return `name: Verify

on:
  pull_request:
  push:
    branches:
      - "dev/v*/v*"
      - "alpha/v*/v*"
      - "release/v*/v*"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    uses: kungfu-systems/buildchain/.github/workflows/check.yml@${buildchainSha}
    with:
      buildchain-ref: ${buildchainSha}
      require-version-state: true
      upload-artifacts: true
`;
}

function scaffoldReleaseWorkflow(
  buildchainSha,
  { artifactPaths = "_build/main.pdf", releasePassportProductName = "" } = {},
) {
  const passportInput = releasePassportProductName
    ? `      release-passport-product-name: ${JSON.stringify(releasePassportProductName)}\n`
    : "";
  return `name: Paper Release

on:
  workflow_dispatch:
  push:
    branches:
      - "alpha/**"
      - "release/**"

permissions:
  contents: read

jobs:
  paper-release:
    uses: kungfu-systems/buildchain/.github/workflows/paper-release-sealed.yml@${buildchainSha}
    permissions:
      actions: read
      checks: write
      contents: read
      id-token: write
      issues: write
      pull-requests: write
    with:
      buildchain-ref: ${buildchainSha}
      buildchain-contract-lock-path: .buildchain/contract-lock.json
      publisher-workflow-path: .github/workflows/paper-release.yml
      toolchain-type: config
      verify-command: make check
      artifact-paths: ${JSON.stringify(artifactPaths)}
${passportInput}    secrets:
      KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY: \${{ secrets.KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY }}
      BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID: \${{ secrets.BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID }}
      BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY: \${{ secrets.BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY }}
      BUILDCHAIN_GENERATED_WRITE_TOKEN: \${{ secrets.BUILDCHAIN_GENERATED_WRITE_TOKEN }}
      BUILDCHAIN_PROMOTION_TOKEN: \${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
`;
}

function paperProvisioningPolicy() {
  return {
    repositoryActions: {
      defaultWorkflowPermissions: "read",
      canApprovePullRequestReviews: false,
    },
    generatedWrites: {
      preferredAuthority: "github-app",
      compatibilityAuthority: "narrow-token",
      githubTokenFallback: false,
      permissions: ["checks:write", "contents:write", "pull-requests:write"],
      tokenPersistence: "runtime-only",
    },
    release: {
      protectedReviewRequired: true,
      versionState: "not-required",
      identityOnlyPullRequests: false,
      manualVersionStateRepairPullRequests: false,
    },
    roles: {
      actor: "repository-development-role",
      pusher: "repository-development-role",
      reviewer: "independent-review-role",
      generatedWriteAuthority: "github-app-or-narrow-token",
    },
  };
}

export function createPaperProvisioningAuthority({
  repository,
  packageName,
  buildchainVersion,
  buildchainSha,
  contractLock,
  buildWorkflow,
  verifyWorkflow,
  releaseWorkflow,
  agentEntry,
  agentInstructions,
  environment = "",
}) {
  const policy = paperProvisioningPolicy();
  const payload = {
    schemaVersion: 1,
    contract: PAPER_PROVISIONING_CONTRACT,
    repository,
    package: {
      name: packageName,
      registry: NPM_REGISTRY,
      bootstrapVersion: DEFAULT_BOOTSTRAP_VERSION,
    },
    runtime: {
      repository: "kungfu-systems/buildchain",
      version: buildchainVersion,
      ref: buildchainSha,
      resolvedSha: buildchainSha,
    },
    workflows: {
      build: {
        path: PAPER_PATHS.buildWorkflow,
        sourceDigest: sha256Text(buildWorkflow),
        reusablePath: ".github/workflows/publication-artifact.yml",
        reusableRef: buildchainSha,
      },
      verify: {
        path: PAPER_PATHS.verifyWorkflow,
        sourceDigest: sha256Text(verifyWorkflow),
        reusablePath: ".github/workflows/check.yml",
        reusableRef: buildchainSha,
      },
      release: {
        path: PAPER_PATHS.releaseWorkflow,
        sourceDigest: sha256Text(releaseWorkflow),
        reusablePath: ".github/workflows/paper-release-sealed.yml",
        reusableRef: buildchainSha,
      },
    },
    agentEntry: {
      contract: PAPER_AGENT_ENTRY_CONTRACT,
      policyPath: PAPER_PATHS.agentEntry,
      policyDigest: sha256Text(agentEntry),
      instructionsPath: PAPER_PATHS.agentInstructions,
      instructionsDigest: sha256Text(agentInstructions),
    },
    admission: {
      contractLockPath: PAPER_PATHS.contractLock,
      contractLockDigest: sha256Text(contractLock),
      acceptedRef: buildchainSha,
      acceptedSha: buildchainSha,
    },
    trustedPublisher: {
      type: "github",
      repository,
      workflow: path.posix.basename(PAPER_PATHS.releaseWorkflow),
      environment,
    },
    policy: {
      ...policy,
      policyDigest: sha256Text(stableJson(policy)),
    },
  };
  return {
    ...payload,
    authorityDigest: sha256Text(stableJson(payload)),
  };
}

function scaffoldFiles({
  buildchainRoot,
  buildchainVersion,
  buildchainRef,
  buildchainSha,
  cwd,
  name,
  title,
  packageName,
  repository,
  version,
  siteBaseUrl,
}) {
  const contractWorld = runtimeContractWorld(buildchainRoot);
  const existingLock = readJson(
    path.resolve(cwd, PAPER_PATHS.contractLock),
  ).value;
  const acceptedAt =
    existingLock?.buildchain?.acceptedAt ||
    runtimeAcceptedAt(buildchainRoot, buildchainSha, buildchainVersion);
  const contractLock = createBuildchainContractLock({
    buildchainRef,
    resolvedSha: buildchainSha,
    contractWorld,
    acceptedAt,
  });
  const contractLockText = jsonText(contractLock);
  const buildWorkflow = scaffoldBuildWorkflow(buildchainSha, {
    artifactName: name,
  });
  const releaseWorkflow = scaffoldReleaseWorkflow(buildchainSha, {
    artifactPaths: "_build/main.pdf",
    releasePassportProductName: title,
  });
  const verifyWorkflow = scaffoldVerifyWorkflow(buildchainSha);
  const agentEntry = paperAgentEntryFiles({
    cwd,
    buildchainVersion,
    buildchainSha,
    developmentRef: `dev/v${parsePaperVersion(version).major}/v${
      parsePaperVersion(version).major
    }.${parsePaperVersion(version).minor}`,
  });
  const provisioningAuthority = createPaperProvisioningAuthority({
    repository,
    packageName,
    buildchainVersion,
    buildchainSha,
    contractLock: contractLockText,
    buildWorkflow,
    verifyWorkflow,
    releaseWorkflow,
    agentEntry: agentEntry.get(PAPER_PATHS.agentEntry),
    agentInstructions: agentEntry.get(PAPER_PATHS.agentInstructions),
  });
  const licenseText = runtimeLicenseText(buildchainRoot);
  return new Map([
    [
      PAPER_PATHS.config,
      scaffoldConfig({
        name,
        title,
        packageName,
        version,
        siteBaseUrl,
      }),
    ],
    [PAPER_PATHS.contractLock, contractLockText],
    [PAPER_PATHS.versionPin, `${buildchainVersion}\n`],
    [PAPER_PATHS.buildWorkflow, buildWorkflow],
    [PAPER_PATHS.verifyWorkflow, verifyWorkflow],
    [PAPER_PATHS.releaseWorkflow, releaseWorkflow],
    [PAPER_PATHS.pnpmWorkspace, paperPnpmWorkspace("", buildchainVersion)],
    [PAPER_PATHS.provisioningAuthority, jsonText(provisioningAuthority)],
    ...agentEntry,
    [
      "Makefile",
      scaffoldMakefile({
        image: DEFAULT_TOOLCHAIN_IMAGE,
        digest: DEFAULT_TOOLCHAIN_DIGEST,
        command: DEFAULT_TOOLCHAIN_COMMAND,
      }),
    ],
    [
      "package.json",
      scaffoldPackageJson({
        name,
        packageName,
        repository,
        buildchainVersion,
      }),
    ],
    ["README.md", scaffoldReadme({ title, packageName })],
    ["docs/MAP.md", scaffoldMap()],
    ["paper/main.tex", scaffoldMainTex(title)],
    ["paper/references.bib", "% Add reviewed bibliography entries here.\n"],
    ["LICENSE", licenseText],
    [
      ".gitignore",
      "_build/\n.buildchain/publication/\n.buildchain/release-state/\n.buildchain/release-evidence/\n.buildchain/paper/npm-bootstrap.json\n.buildchain/paper/npm-trust.json\n",
    ],
  ]);
}

export function planPaperScaffold({
  cwd = process.cwd(),
  buildchainRoot = process.cwd(),
  buildchainVersion = "",
  buildchainRef = "v3",
  buildchainSha = "",
  name = path.basename(path.resolve(cwd)),
  title = "",
  packageName = "",
  repository = "",
  version = "0.1.0-alpha.0",
  siteBaseUrl = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const normalizedName = String(name || "").trim();
  if (!normalizedName) throw new Error("paper scaffold requires --name");
  const normalizedPackage = normalizePackageName(packageName);
  const normalizedRepository = normalizeRepository(repository);
  if (!normalizedRepository) {
    throw new Error("paper scaffold requires --repository <owner/repo>");
  }
  const normalizedVersion = String(version || "")
    .trim()
    .replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalizedVersion)) {
    throw new Error("paper scaffold --version must be semver");
  }
  const runtimeIdentity = buildchainPackageIdentity(
    buildchainRoot,
    buildchainVersion,
  );
  const runtimeSha =
    buildchainSha ||
    resolvePaperRuntimeGitSha(buildchainRoot, runtimeIdentity.version);
  if (!GIT_SHA_PATTERN.test(runtimeSha)) {
    throw new Error(
      "paper scaffold cannot resolve the exact Buildchain runtime SHA; pass buildchainSha or use a published Buildchain package with npm gitHead provenance",
    );
  }
  const files = scaffoldFiles({
    buildchainRoot,
    buildchainVersion: runtimeIdentity.version,
    buildchainRef,
    buildchainSha: runtimeSha,
    cwd: resolvedCwd,
    name: normalizedName,
    title: title || normalizedName,
    packageName: normalizedPackage,
    repository: normalizedRepository,
    version: normalizedVersion,
    siteBaseUrl,
  });
  const changes = [...files.entries()].map(([relativePath, content]) => {
    const filePath = path.resolve(resolvedCwd, relativePath);
    const exists = fs.existsSync(filePath);
    if (!exists) {
      return {
        path: relativePath,
        action: "create",
        sha256: sha256Text(content),
        content,
      };
    }
    if (!fs.statSync(filePath).isFile()) {
      return {
        path: relativePath,
        action: "conflict",
        reason: "path-exists-and-is-not-a-file",
        sha256: sha256Text(content),
        content,
      };
    }
    const current = fs.readFileSync(filePath, "utf8");
    return current === content
      ? {
          path: relativePath,
          action: "unchanged",
          sha256: sha256Text(content),
          content,
        }
      : {
          path: relativePath,
          action: "conflict",
          reason: "existing-content-differs",
          currentSha256: sha256Text(current),
          sha256: sha256Text(content),
          content,
        };
  });
  const publicChanges = changes.map(({ content: _content, ...entry }) => entry);
  const conflicts = publicChanges.filter(
    (entry) => entry.action === "conflict",
  );
  const result = {
    schemaVersion: 1,
    contract: PAPER_SCAFFOLD_CONTRACT,
    ok: conflicts.length === 0,
    cwd: resolvedCwd,
    dryRun: true,
    identity: {
      project: normalizedName,
      title: title || normalizedName,
      package: normalizedPackage,
      repository: normalizedRepository,
      version: normalizedVersion,
    },
    buildchain: {
      version: runtimeIdentity.version,
      ref: runtimeSha,
      resolvedSha: runtimeSha,
    },
    summary: {
      create: publicChanges.filter((entry) => entry.action === "create").length,
      unchanged: publicChanges.filter((entry) => entry.action === "unchanged")
        .length,
      conflict: conflicts.length,
    },
    changes: publicChanges,
    conflicts,
    nextActions:
      conflicts.length > 0
        ? [
            {
              id: "resolve-scaffold-conflicts",
              command: "",
              description:
                "Resolve the listed semantic conflicts; scaffold never overwrites them.",
            },
          ]
        : [
            {
              id: "write-scaffold",
              command: "buildchain paper scaffold --write <same arguments>",
              description:
                "Write only missing files after the conflict-free plan is reviewed.",
            },
          ],
  };
  Object.defineProperty(result, "_plannedFiles", {
    value: changes,
    enumerable: false,
  });
  return result;
}

export function writePaperScaffold(plan) {
  if (!plan || plan.contract !== PAPER_SCAFFOLD_CONTRACT) {
    throw new Error("paper scaffold plan contract mismatch");
  }
  if (!plan.ok || plan.conflicts.length > 0) {
    return {
      ...plan,
      dryRun: false,
      written: [],
      ok: false,
      errorCode: "paper-scaffold-conflict",
    };
  }
  const resolvedCwd = path.resolve(plan.cwd);
  const creates = plan._plannedFiles.filter(
    (entry) => entry.action === "create",
  );
  for (const entry of creates) {
    const target = path.resolve(resolvedCwd, entry.path);
    if (fs.existsSync(target)) {
      const current = fs.statSync(target).isFile()
        ? fs.readFileSync(target, "utf8")
        : undefined;
      if (current !== entry.content) {
        throw new Error(
          `paper scaffold race detected at ${entry.path}; no file was overwritten`,
        );
      }
      continue;
    }
  }
  const written = [];
  for (const entry of creates) {
    const target = path.resolve(resolvedCwd, entry.path);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content, { flag: "wx" });
    written.push(entry.path);
  }
  return {
    ...plan,
    ok: true,
    dryRun: false,
    written,
    idempotent: written.length === 0,
    nextActions: [
      {
        id: "paper-preflight",
        command: `buildchain paper preflight --cwd ${JSON.stringify(resolvedCwd)} --json`,
        description:
          "Verify the generated repository before any external mutation.",
      },
    ],
  };
}

function migrationFiles({
  cwd,
  buildchainRoot,
  buildchainVersion,
  buildchainSha,
}) {
  const configResult = paperConfig(cwd);
  if (configResult.error) {
    throw new Error(
      `paper migration requires a valid publication config: ${configResult.error}`,
    );
  }
  validateBuildchainConfig(cwd, { requireLifecycleStages: ["verify"] });
  const config = configResult.loaded.config;
  const repository = resolvePaperRepository(cwd);
  if (!repository) {
    throw new Error(
      "paper migration requires an exact GitHub repository identity",
    );
  }
  const packageName = normalizePackageName(
    config.publish?.package || config.publish?.mainPackage || "",
    "paper publish package",
  );
  const runtimeSha =
    buildchainSha ||
    resolvePaperRuntimeGitSha(buildchainRoot, buildchainVersion);
  if (!GIT_SHA_PATTERN.test(runtimeSha)) {
    throw new Error("paper migration requires an exact Buildchain source SHA");
  }
  const runtimeIdentity = buildchainPackageIdentity(
    buildchainRoot,
    buildchainVersion,
  );
  if (!runtimeIdentity.version) {
    throw new Error(
      "paper migration requires an exact Buildchain package version",
    );
  }
  const existingLock = readJson(
    path.resolve(cwd, PAPER_PATHS.contractLock),
  ).value;
  const contractLock = createBuildchainContractLock({
    buildchainRef: "v3",
    resolvedSha: runtimeSha,
    contractWorld: runtimeContractWorld(buildchainRoot),
    acceptedAt:
      existingLock?.buildchain?.resolvedSha === runtimeSha
        ? existingLock.buildchain.acceptedAt
        : runtimeAcceptedAt(
            buildchainRoot,
            runtimeSha,
            runtimeIdentity.version,
          ),
  });
  const contractLockText = jsonText(contractLock);
  const buildWorkflow = scaffoldBuildWorkflow(runtimeSha, {
    artifactName: config.project.name,
  });
  const releaseWorkflow = scaffoldReleaseWorkflow(runtimeSha, {
    artifactPaths: config.publication.artifactPaths.join(","),
    releasePassportProductName: config.publication.title,
  });
  const verifyWorkflow = scaffoldVerifyWorkflow(runtimeSha);
  const agentEntry = paperAgentEntryFiles({
    cwd,
    buildchainVersion: runtimeIdentity.version,
    buildchainSha: runtimeSha,
  });
  const provisioningAuthority = createPaperProvisioningAuthority({
    repository,
    packageName,
    buildchainVersion: runtimeIdentity.version,
    buildchainSha: runtimeSha,
    contractLock: contractLockText,
    buildWorkflow,
    verifyWorkflow,
    releaseWorkflow,
    agentEntry: agentEntry.get(PAPER_PATHS.agentEntry),
    agentInstructions: agentEntry.get(PAPER_PATHS.agentInstructions),
  });
  const currentPackage = readJson(path.resolve(cwd, "package.json"));
  if (!currentPackage.exists || currentPackage.error || !currentPackage.value) {
    throw new Error("paper migration requires a valid package.json");
  }
  const packageJson = managedPaperPackageJson(
    currentPackage.value,
    runtimeIdentity.version,
  );
  const pnpmWorkspacePath = path.resolve(cwd, PAPER_PATHS.pnpmWorkspace);
  const pnpmWorkspace = paperPnpmWorkspace(
    fs.existsSync(pnpmWorkspacePath)
      ? fs.readFileSync(pnpmWorkspacePath, "utf8")
      : "",
    runtimeIdentity.version,
  );
  const files = new Map([
    [PAPER_PATHS.contractLock, contractLockText],
    [PAPER_PATHS.versionPin, `${runtimeIdentity.version}\n`],
    [PAPER_PATHS.buildWorkflow, buildWorkflow],
    [PAPER_PATHS.verifyWorkflow, verifyWorkflow],
    [PAPER_PATHS.releaseWorkflow, releaseWorkflow],
    [PAPER_PATHS.pnpmWorkspace, pnpmWorkspace],
    [PAPER_PATHS.provisioningAuthority, jsonText(provisioningAuthority)],
    ...agentEntry,
    ["package.json", jsonText(packageJson)],
  ]);
  return files;
}

export function planPaperMigration({
  cwd = process.cwd(),
  buildchainRoot = process.cwd(),
  buildchainVersion = "",
  buildchainSha = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const repositoryRoot = gitValue(resolvedCwd, [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (
    !repositoryRoot ||
    fs.realpathSync(repositoryRoot) !== fs.realpathSync(resolvedCwd)
  ) {
    throw new Error("paper migration must target the exact repository root");
  }
  const source = {
    head: gitValue(resolvedCwd, ["rev-parse", "HEAD"]),
    clean: gitResult(resolvedCwd, ["status", "--porcelain"]).stdout === "",
  };
  if (!GIT_SHA_PATTERN.test(source.head)) {
    throw new Error("paper migration requires a committed Git source");
  }
  const plannedFiles = [
    ...migrationFiles({
      cwd: resolvedCwd,
      buildchainRoot,
      buildchainVersion,
      buildchainSha,
    }),
  ].map(([relativePath, content]) => {
    const target = path.resolve(resolvedCwd, relativePath);
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
      return {
        path: relativePath,
        action: "conflict",
        currentSha256: "",
        sha256: sha256Text(content),
        content,
      };
    }
    const current = fs.existsSync(target)
      ? fs.readFileSync(target, "utf8")
      : undefined;
    return {
      path: relativePath,
      action:
        current === undefined
          ? "create"
          : current === content
            ? "unchanged"
            : "update",
      currentSha256: current === undefined ? "" : sha256Text(current),
      sha256: sha256Text(content),
      content,
    };
  });
  const changes = plannedFiles.map(({ content: _content, ...entry }) => entry);
  const conflicts = changes.filter((entry) => entry.action === "conflict");
  const ok = source.clean && conflicts.length === 0;
  const result = {
    schemaVersion: 1,
    contract: PAPER_MIGRATION_CONTRACT,
    ok,
    cwd: resolvedCwd,
    dryRun: true,
    source,
    summary: {
      create: changes.filter((entry) => entry.action === "create").length,
      update: changes.filter((entry) => entry.action === "update").length,
      unchanged: changes.filter((entry) => entry.action === "unchanged").length,
      conflict: conflicts.length,
    },
    changes,
    conflicts,
    nextActions: !source.clean
      ? [
          {
            id: "commit-source",
            command: "git status --short",
            description:
              "Migration only rewrites Buildchain-owned control files from a clean committed source.",
          },
        ]
      : conflicts.length > 0
        ? [
            {
              id: "resolve-migration-conflicts",
              command: "",
              description:
                "Resolve non-file targets; migration never replaces a directory or special path.",
            },
          ]
        : [
            {
              id: "write-migration",
              command: "buildchain paper migrate --write --json",
              description:
                "Write the reviewed Buildchain-owned control files without changing paper content or publication configuration.",
            },
            {
              id: "refresh-pnpm-lock",
              command: "pnpm install --lockfile-only",
              description:
                "Bind the exact Buildchain v3 dependency into pnpm-lock.yaml after the reviewed package update.",
            },
          ],
  };
  Object.defineProperty(result, "_plannedFiles", {
    value: plannedFiles,
    enumerable: false,
  });
  return result;
}

export function writePaperMigration(plan) {
  if (!plan || plan.contract !== PAPER_MIGRATION_CONTRACT) {
    throw new Error("paper migration plan contract mismatch");
  }
  if (!plan.ok) {
    return {
      ...plan,
      dryRun: false,
      written: [],
      updated: [],
      ok: false,
      errorCode: "paper-migration-blocked",
    };
  }
  const written = [];
  const updated = [];
  for (const entry of plan._plannedFiles) {
    if (entry.action === "unchanged") continue;
    const target = path.resolve(plan.cwd, entry.path);
    const exists = fs.existsSync(target);
    const current =
      exists && fs.statSync(target).isFile()
        ? fs.readFileSync(target, "utf8")
        : undefined;
    const currentSha256 = current === undefined ? "" : sha256Text(current);
    if (
      (entry.action === "create" && exists) ||
      (entry.action === "update" && currentSha256 !== entry.currentSha256)
    ) {
      throw new Error(
        `paper migration race detected at ${entry.path}; no stale plan was applied`,
      );
    }
  }
  for (const entry of plan._plannedFiles) {
    if (entry.action === "unchanged") continue;
    const target = path.resolve(plan.cwd, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content, {
      flag: entry.action === "create" ? "wx" : "w",
    });
    (entry.action === "create" ? written : updated).push(entry.path);
  }
  return {
    ...plan,
    ok: true,
    dryRun: false,
    written,
    updated,
    idempotent: written.length === 0 && updated.length === 0,
    nextActions: [
      {
        id: "paper-preflight",
        command: `buildchain paper preflight --cwd ${JSON.stringify(plan.cwd)} --offline --json`,
        description:
          "Verify the migrated repository before any external mutation.",
      },
    ],
  };
}

function state(id, status, reason, evidence = []) {
  return {
    id,
    status,
    satisfied: status === "satisfied",
    reason,
    evidence: evidence.filter(Boolean),
  };
}

function transactionCandidates(cwd, version) {
  const stateDir = path.resolve(cwd, ".buildchain/release-state");
  if (!fs.existsSync(stateDir) || !fs.statSync(stateDir).isDirectory()) {
    return [];
  }
  const preferred = new Set([`${version}.json`, `v${version}.json`]);
  return fs
    .readdirSync(stateDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => {
      const leftRank = preferred.has(left) ? 0 : 1;
      const rightRank = preferred.has(right) ? 0 : 1;
      return leftRank - rightRank || left.localeCompare(right);
    })
    .map((entry) => {
      const filePath = path.join(stateDir, entry);
      try {
        const transaction = readReleaseTransaction(filePath);
        return {
          path: toPosix(path.relative(cwd, filePath)),
          transaction,
          error: "",
        };
      } catch (error) {
        return {
          path: toPosix(path.relative(cwd, filePath)),
          transaction: undefined,
          error: error.message,
        };
      }
    });
}

function explicitVisibilityState(value, channel) {
  const entry = value?.channels?.[channel];
  return Boolean(
    value?.contract === PAPER_VISIBILITY_CONTRACT &&
    entry?.status === "visible" &&
    typeof entry.url === "string" &&
    entry.url &&
    SHA256_PATTERN.test(String(entry.evidenceDigest || "")),
  );
}

function admissionSatisfied(value) {
  const digestPattern = /^(?:sha256:)?[0-9a-f]{64}$/i;
  if (value?.contract === "kungfu-buildchain-publication-admission") {
    return digestPattern.test(String(value.admissionDigest || ""));
  }
  if (value?.contract === "kungfu-buildchain-publication-capability") {
    return (
      value.decision === "allow" &&
      digestPattern.test(String(value.capabilityDigest || ""))
    );
  }
  return false;
}

function bootstrapSatisfied(value) {
  return Boolean(
    value?.contract === PAPER_NPM_BOOTSTRAP_CONTRACT &&
    ["existing", "published"].includes(value?.publish?.status) &&
    value?.package?.name,
  );
}

function trustSatisfied(value) {
  return Boolean(
    value?.contract === PAPER_NPM_BOOTSTRAP_CONTRACT &&
    value?.trust?.status === "configured",
  );
}

function contentReadiness(cwd, publication) {
  const required = [...publication.sourcePaths, ...publication.metadataPaths];
  const missing = required.filter(
    (entry) => !fs.existsSync(path.resolve(cwd, entry)),
  );
  return {
    ok: required.length > 0 && missing.length === 0,
    required,
    missing,
  };
}

function releaseTransactionFacts(candidates, version) {
  const matching = candidates.filter(({ transaction }) => {
    if (!transaction) return false;
    return (
      String(transaction.version || "").replace(/^v/, "") ===
      String(version || "").replace(/^v/, "")
    );
  });
  const selected =
    matching[0] ||
    candidates.find(({ transaction }) => transaction) ||
    undefined;
  const publicationState = selected?.transaction
    ? releaseTransactionPublicationState(selected.transaction)
    : "";
  return {
    matching,
    selected,
    publicationState,
  };
}

function collectPaperGovernanceFacts(resolvedCwd) {
  const configResult = paperConfig(resolvedCwd);
  const loaded = configResult.loaded;
  const publication = loaded?.config?.publication;
  const publish = loaded?.config?.publish;
  const packageName = publish?.package || publish?.mainPackage || "";
  const version = publication?.version || "";
  const configFact = existingFileFact(
    resolvedCwd,
    loaded?.path || PAPER_PATHS.config,
  );
  const scaffoldFacts = PAPER_SCAFFOLD_PATHS.map((relativePath) =>
    existingFileFact(resolvedCwd, relativePath),
  );
  const contractLockPath = path.resolve(resolvedCwd, PAPER_PATHS.contractLock);
  const contractLockJson = readJson(contractLockPath);
  let contractLock;
  let contractLockError = contractLockJson.error;
  if (contractLockJson.exists && !contractLockError) {
    try {
      contractLock = readBuildchainContractLock(contractLockPath);
    } catch (error) {
      contractLockError = error.message;
    }
  }
  const gitRepo = gitResult(resolvedCwd, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  const scaffoldOk = Boolean(
    !configResult.error && scaffoldFacts.every(Boolean),
  );
  const governedOk = Boolean(
    scaffoldOk &&
    contractLock &&
    GIT_SHA_PATTERN.test(contractLock.buildchain?.resolvedSha || "") &&
    SHA256_PATTERN.test(contractLock.buildchain?.contractDigest || "") &&
    SHA256_PATTERN.test(contractLock.buildchain?.compatibilityDigest || "") &&
    gitRepo.ok &&
    gitRepo.stdout === "true",
  );
  return {
    configResult, loaded, publication, packageName, version, configFact,
    scaffoldFacts, contractLockError, scaffoldOk, governedOk,
  };
}

function collectPaperEvidenceFacts(resolvedCwd, publication, version) {
  const admissionInputs = [PAPER_PATHS.capability, PAPER_PATHS.admission].map(
    (relativePath) => ({
      relativePath,
      ...readJson(path.resolve(resolvedCwd, relativePath)),
    }),
  );
  const admitted = admissionInputs.find((entry) =>
    admissionSatisfied(entry.value),
  );
  const bootstrap = readJson(
    path.resolve(resolvedCwd, PAPER_PATHS.npmBootstrap),
  );
  const trust = readJson(path.resolve(resolvedCwd, PAPER_PATHS.npmTrust));
  const bootstrapValue = bootstrap.value;
  const trustValue = trust.value || bootstrap.value;
  const content = publication
    ? contentReadiness(resolvedCwd, publication)
    : { ok: false, required: [], missing: [] };
  const reproducibility = readJson(
    path.resolve(resolvedCwd, PAPER_PATHS.reproducibilityReceipt),
  );
  const deterministic = Boolean(
    reproducibility.value?.contract ===
      PUBLICATION_REPRODUCIBILITY_RECEIPT_CONTRACT &&
    reproducibility.value?.status === "passed" &&
    reproducibility.value?.qualifying === true,
  );
  const sealed = readJson(path.resolve(resolvedCwd, PAPER_PATHS.sealedBundle));
  let sealedOk = false;
  let sealedError = sealed.error;
  if (sealed.value?.contract === PUBLICATION_SEALED_BUNDLE_CONTRACT) {
    try {
      verifyPublicationSealedBundle({
        bundleRoot: resolvedCwd,
        manifest: sealed.value,
      });
      sealedOk = true;
    } catch (error) {
      sealedError = error.message;
    }
  }
  const candidates = transactionCandidates(resolvedCwd, version);
  const transactionFacts = releaseTransactionFacts(candidates, version);
  const packagePublished = [
    "package-published",
    "alpha-complete",
    "release-complete",
  ].includes(transactionFacts.publicationState);
  const alphaComplete = transactionFacts.publicationState === "alpha-complete";
  const visibility = readJson(
    path.resolve(resolvedCwd, PAPER_PATHS.visibility),
  );
  const stagingVisible = explicitVisibilityState(visibility.value, "staging");
  const productionVisible = explicitVisibilityState(
    visibility.value,
    "production",
  );
  return {
    admitted, bootstrapValue, trustValue, content, reproducibility, deterministic,
    sealedOk, sealedError, candidates, transactionFacts, packagePublished,
    alphaComplete, stagingVisible, productionVisible,
  };
}

function paperStatusBlockingNextActions({ stateMap, deterministic, transactionFacts }) {
  const actions = [];
  if (!stateMap.scaffolded.satisfied) {
    actions.push({
      id: "scaffold-paper",
      command: "buildchain paper scaffold --help",
      description: "Plan a no-overwrite Buildchain paper scaffold.",
    });
  } else if (!stateMap.governed.satisfied) {
    actions.push({
      id: "restore-governance",
      command: "buildchain paper preflight --json",
      description:
        "Repair the Git/contract-lock governance checks reported by preflight.",
    });
  } else if (!stateMap["content-ready"].satisfied) {
    actions.push({
      id: "complete-paper-content",
      command: "make check",
      description: "Add every declared paper source and metadata input.",
    });
  } else if (!deterministic) {
    actions.push({
      id: "build-reproducible-artifact",
      command: "buildchain paper build --execute --json",
      description:
        "Run the existing two-clean-build reproducibility gate and promote exact bytes.",
    });
  } else if (
    !stateMap.bootstrapped.satisfied ||
    !stateMap["trust-bound"].satisfied
  ) {
    actions.push({
      id: "bootstrap-npm",
      command: "buildchain paper bootstrap npm --json",
      description:
        "Inspect the dry-run npm bootstrap and Trusted Publishing handoff.",
    });
  } else if (!stateMap["alpha-complete"].satisfied) {
    actions.push({
      id: transactionFacts.selected ? "resume-alpha" : "start-alpha",
      command: transactionFacts.selected
        ? "buildchain paper resume --json"
        : "buildchain paper alpha --json",
      description: transactionFacts.selected
        ? "Resume the exact sealed release transaction."
        : "Plan the protected dev-to-alpha publication PR.",
    });
  }
  return actions;
}

export function collectPaperStatus({ cwd = process.cwd() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const governance = collectPaperGovernanceFacts(resolvedCwd);
  const evidence = collectPaperEvidenceFacts(
    resolvedCwd,
    governance.publication,
    governance.version,
  );
  const {
    configResult, loaded, publication, packageName, version, configFact,
    scaffoldFacts, contractLockError, scaffoldOk, governedOk,
  } = governance;
  const {
    admitted, bootstrapValue, trustValue, content, reproducibility, deterministic,
    sealedOk, sealedError, candidates, transactionFacts, packagePublished,
    alphaComplete, stagingVisible, productionVisible,
  } = evidence;

  const states = [
    state(
      "scaffolded",
      scaffoldOk ? "satisfied" : configFact ? "blocked" : "not-reached",
      scaffoldOk
        ? "The complete managed paper scaffold inventory is present."
        : configResult.error || "Paper scaffold is incomplete.",
      scaffoldFacts,
    ),
    state(
      "governed",
      governedOk ? "satisfied" : scaffoldOk ? "blocked" : "not-reached",
      governedOk
        ? "The repository is Git-governed and carries a valid Buildchain contract lock."
        : contractLockError ||
            "Git governance or the Buildchain contract lock is missing.",
      [existingFileFact(resolvedCwd, PAPER_PATHS.contractLock)],
    ),
    state(
      "admitted",
      admitted ? "satisfied" : "not-reached",
      admitted
        ? "Explicit publication admission/capability evidence is present."
        : "No explicit publication admission evidence is present; no admission is inferred.",
      admitted ? [existingFileFact(resolvedCwd, admitted.relativePath)] : [],
    ),
    state(
      "bootstrapped",
      bootstrapSatisfied(bootstrapValue) ? "satisfied" : "not-reached",
      bootstrapSatisfied(bootstrapValue)
        ? "A typed npm package bootstrap receipt exists."
        : "No typed npm bootstrap receipt proves that the public package exists.",
      [existingFileFact(resolvedCwd, PAPER_PATHS.npmBootstrap)],
    ),
    state(
      "trust-bound",
      trustSatisfied(trustValue) ? "satisfied" : "not-reached",
      trustSatisfied(trustValue)
        ? "A typed receipt proves npm Trusted Publishing is configured."
        : "No typed receipt proves the npm Trusted Publisher binding.",
      [
        existingFileFact(resolvedCwd, PAPER_PATHS.npmTrust),
        existingFileFact(resolvedCwd, PAPER_PATHS.npmBootstrap),
      ],
    ),
    state(
      "content-ready",
      content.ok ? "satisfied" : publication ? "blocked" : "not-reached",
      content.ok
        ? "Every declared source and metadata input exists."
        : `Declared content is missing: ${content.missing.join(", ") || "publication config unavailable"}.`,
      content.required.map((entry) => existingFileFact(resolvedCwd, entry)),
    ),
    state(
      "artifact-sealed",
      deterministic && sealedOk ? "satisfied" : "not-reached",
      deterministic && sealedOk
        ? "A qualifying reproducibility receipt and verified sealed bundle bind exact artifact bytes."
        : sealedError ||
            "Artifact sealing requires both qualifying reproducibility and an exact sealed bundle; neither is inferred.",
      [
        existingFileFact(resolvedCwd, PAPER_PATHS.reproducibilityReceipt),
        existingFileFact(resolvedCwd, PAPER_PATHS.sealedBundle),
      ],
    ),
    state(
      "package-published",
      packagePublished ? "satisfied" : "not-reached",
      packagePublished
        ? `Release transaction explicitly reports ${transactionFacts.publicationState}.`
        : "No release transaction explicitly proves package publication.",
      transactionFacts.selected
        ? [existingFileFact(resolvedCwd, transactionFacts.selected.path)]
        : [],
    ),
    state(
      "alpha-complete",
      alphaComplete ? "satisfied" : "not-reached",
      alphaComplete
        ? "The alpha release transaction is complete."
        : "No completed alpha transaction is present.",
      transactionFacts.selected
        ? [existingFileFact(resolvedCwd, transactionFacts.selected.path)]
        : [],
    ),
    state(
      "staging-visible",
      stagingVisible ? "satisfied" : "not-reached",
      stagingVisible
        ? "Explicit digest-bound staging visibility evidence is present."
        : "No explicit staging visibility evidence is present; visibility is not inferred from publication.",
      [existingFileFact(resolvedCwd, PAPER_PATHS.visibility)],
    ),
    state(
      "production-visible",
      productionVisible ? "satisfied" : "not-reached",
      productionVisible
        ? "Explicit digest-bound production visibility evidence is present."
        : "No explicit production visibility evidence is present; visibility is not inferred from staging.",
      [existingFileFact(resolvedCwd, PAPER_PATHS.visibility)],
    ),
  ];
  const achieved = states
    .filter((entry) => entry.satisfied)
    .map((entry) => entry.id);
  const highestEvidenceState =
    [...states].reverse().find((entry) => entry.satisfied)?.id || "none";
  const stateMap = Object.fromEntries(states.map((entry) => [entry.id, entry]));
  const blockingNextActions = paperStatusBlockingNextActions({ stateMap, deterministic, transactionFacts });
  return {
    schemaVersion: 1,
    contract: PAPER_STATUS_CONTRACT,
    ok: !configResult.error,
    cwd: resolvedCwd,
    identity: {
      project: loaded?.config?.project?.name || "",
      package: packageName,
      version,
      repository: resolvePaperRepository(resolvedCwd),
    },
    states,
    achieved,
    highestEvidenceState,
    deterministicBuild: {
      status: deterministic
        ? "qualifying"
        : reproducibility.exists
          ? "non-qualifying"
          : "not-run",
      receiptPath: PAPER_PATHS.reproducibilityReceipt,
      receiptDigest: reproducibility.value?.receiptDigest || "",
    },
    transaction: transactionFacts.selected
      ? {
          path: transactionFacts.selected.path,
          id: transactionFacts.selected.transaction.id || "",
          state: transactionFacts.selected.transaction.state || "",
          publicationState: transactionFacts.publicationState,
          targetRef: transactionFacts.selected.transaction.target_ref || "",
          sourceSha: transactionFacts.selected.transaction.source_sha || "",
          resumeCommand:
            transactionFacts.selected.transaction.resume_command || "",
        }
      : null,
    conflicts: [
      ...candidates
        .filter((entry) => entry.error)
        .map((entry) => ({
          code: "release-state-invalid",
          path: entry.path,
          message: entry.error,
        })),
      ...(transactionFacts.matching.length > 1
        ? [
            {
              code: "multiple-release-transactions-for-version",
              paths: transactionFacts.matching.map((entry) => entry.path),
              message:
                "More than one release transaction claims the configured publication version.",
            },
          ]
        : []),
    ],
    blockingNextActions,
    nonClaims: [
      "npm package existence is not inferred without a typed receipt or live preflight observation",
      "publication admission is not inferred from reproducibility",
      "package publication is not inferred from a local npm package directory",
      "staging and production visibility are never inferred from alpha completion",
    ],
  };
}

function validatePaperProvisioningAuthority(cwd) {
  const authorityPath = path.resolve(cwd, PAPER_PATHS.provisioningAuthority);
  const source = readJson(authorityPath);
  if (!source.exists) {
    return {
      exists: false,
      valid: false,
      value: undefined,
      errors: ["paper provisioning authority is missing"],
    };
  }
  if (source.error || !source.value) {
    return {
      exists: true,
      valid: false,
      value: source.value,
      errors: [source.error || "paper provisioning authority is invalid"],
    };
  }
  const value = source.value;
  const errors = [];
  if (value.contract !== PAPER_PROVISIONING_CONTRACT) {
    errors.push("paper provisioning authority contract mismatch");
  }
  const { authorityDigest, ...payload } = value;
  if (
    !SHA256_PATTERN.test(String(authorityDigest || "")) ||
    authorityDigest !== sha256Text(stableJson(payload))
  ) {
    errors.push("paper provisioning authority digest mismatch");
  }
  if (
    !GIT_SHA_PATTERN.test(String(value.runtime?.resolvedSha || "")) ||
    value.runtime?.ref !== value.runtime?.resolvedSha ||
    value.admission?.acceptedRef !== value.runtime?.resolvedSha ||
    value.admission?.acceptedSha !== value.runtime?.resolvedSha
  ) {
    errors.push("paper runtime and admission are not bound to one exact SHA");
  }
  if (
    value.package?.registry !== NPM_REGISTRY ||
    value.package?.bootstrapVersion !== DEFAULT_BOOTSTRAP_VERSION
  ) {
    errors.push(
      "paper npm bootstrap authority is not fixed to the official registry and bootstrap version",
    );
  }
  const policy = value.policy || {};
  const { policyDigest, ...policyPayload } = policy;
  if (
    !SHA256_PATTERN.test(String(policyDigest || "")) ||
    policyDigest !== sha256Text(stableJson(policyPayload))
  ) {
    errors.push("paper provisioning policy digest mismatch");
  }
  if (
    policy.repositoryActions?.defaultWorkflowPermissions !== "read" ||
    policy.repositoryActions?.canApprovePullRequestReviews !== false
  ) {
    errors.push("paper repository Actions policy is not least privilege");
  }
  if (
    policy.generatedWrites?.preferredAuthority !== "github-app" ||
    policy.generatedWrites?.githubTokenFallback !== false
  ) {
    errors.push("paper generated-write policy permits an unbounded authority");
  }
  if (
    policy.release?.versionState !== "not-required" ||
    policy.release?.identityOnlyPullRequests !== false ||
    policy.release?.manualVersionStateRepairPullRequests !== false
  ) {
    errors.push(
      "paper release policy permits avoidable bookkeeping pull requests",
    );
  }
  if (value.agentEntry?.contract !== PAPER_AGENT_ENTRY_CONTRACT) {
    errors.push("paper agent-entry authority contract mismatch");
  }
  for (const [entryPath, expectedDigest] of [
    [value.agentEntry?.policyPath, value.agentEntry?.policyDigest],
    [value.agentEntry?.instructionsPath, value.agentEntry?.instructionsDigest],
  ]) {
    if (!entryPath || !SHA256_PATTERN.test(String(expectedDigest || ""))) {
      errors.push("paper agent-entry authority is incomplete");
      continue;
    }
    const absolute = path.resolve(cwd, entryPath);
    if (!fs.existsSync(absolute) || sha256File(absolute) !== expectedDigest) {
      errors.push(`paper agent-entry source digest mismatch: ${entryPath}`);
    }
  }
  for (const workflow of [
    value.workflows?.build,
    value.workflows?.verify,
    value.workflows?.release,
  ]) {
    if (!workflow?.path || !workflow?.sourceDigest) {
      errors.push("paper workflow authority is incomplete");
      continue;
    }
    const absolute = path.resolve(cwd, workflow.path);
    if (
      !fs.existsSync(absolute) ||
      sha256File(absolute) !== workflow.sourceDigest
    ) {
      errors.push(`paper workflow source digest mismatch: ${workflow.path}`);
      continue;
    }
    const text = fs.readFileSync(absolute, "utf8");
    const expectedUse = `${value.runtime.repository}/${workflow.reusablePath}@${value.runtime.resolvedSha}`;
    if (!text.includes(`uses: ${expectedUse}`)) {
      errors.push(
        `paper workflow reusable source is not exact: ${workflow.path}`,
      );
    }
    if (
      workflow.reusablePath !== ".github/workflows/check.yml" &&
      !text.includes(`buildchain-ref: ${value.runtime.resolvedSha}`)
    ) {
      errors.push(
        `paper workflow runtime input is not exact: ${workflow.path}`,
      );
    }
  }
  const lockPath = path.resolve(
    cwd,
    value.admission?.contractLockPath || PAPER_PATHS.contractLock,
  );
  if (
    !fs.existsSync(lockPath) ||
    sha256File(lockPath) !== value.admission?.contractLockDigest
  ) {
    errors.push("paper contract lock bytes differ from provisioning authority");
  }
  return {
    exists: true,
    valid: errors.length === 0,
    value,
    errors,
  };
}

function expectedPaperTrustedPublisher(authority, fallback = {}) {
  const value = authority?.trustedPublisher || {};
  return {
    type: String(value.type || "github").toLowerCase(),
    repository: normalizeRepository(
      value.repository || fallback.repository || "",
    ),
    workflow: toPosix(value.workflow || fallback.workflow || ""),
    environment: String(value.environment || fallback.environment || ""),
  };
}

function normalizedTrustedPublisher(value) {
  return {
    type: String(value?.type || value?.provider || "")
      .trim()
      .toLowerCase()
      .replace(/^github-actions$/, "github"),
    repository: normalizeRepository(value?.repository || value?.repo || ""),
    workflow: toPosix(value?.workflow || value?.file || "").replace(/^\/+/, ""),
    environment: String(value?.environment || value?.env || "").trim(),
  };
}

function trustedPublisherMatches(actual, expected) {
  const normalized = normalizedTrustedPublisher(actual);
  return (
    normalized.type === expected.type &&
    normalized.repository === expected.repository &&
    normalized.workflow === expected.workflow &&
    normalized.environment === expected.environment
  );
}

function runtimeFacts({
  buildchainRoot,
  buildchainVersion,
  buildchainRef,
  buildchainSha,
}) {
  const identity = buildchainPackageIdentity(buildchainRoot, buildchainVersion);
  const contractWorld = runtimeContractWorld(buildchainRoot);
  return {
    version: identity.version,
    ref: buildchainRef,
    resolvedSha:
      buildchainSha ||
      resolvePaperRuntimeGitSha(buildchainRoot, identity.version),
    contract: contractWorld.contract,
    contractDigest: contractWorld.contractDigest,
    compatibilityDigest: contractWorld.compatibilityDigest,
    majorLine: contractWorld.majorLine,
  };
}

function liveNpmPackageObservation(packageName, registry, cwd) {
  const result = commandResult(
    "npm",
    ["view", packageName, "version", "--json", `--registry=${registry}`],
    { cwd },
  );
  if (result.ok) {
    let version = "";
    try {
      const parsed = JSON.parse(result.stdout || '""');
      version = Array.isArray(parsed)
        ? String(parsed.at(-1) || "")
        : String(parsed || "");
    } catch {
      version = result.stdout.replace(/^"|"$/g, "");
    }
    return {
      status: "observed",
      exists: true,
      version,
      registry,
      errorCode: "",
    };
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(output)) {
    return {
      status: "observed",
      exists: false,
      version: "",
      registry,
      errorCode: "package-not-found",
    };
  }
  return {
    status: "unknown",
    exists: null,
    version: "",
    registry,
    errorCode: result.error ? "npm-unavailable" : "npm-view-failed",
  };
}

function liveNpmAuthObservation(registry, cwd) {
  const result = commandResult("npm", ["whoami", `--registry=${registry}`], {
    cwd,
  });
  return {
    status: result.ok ? "authenticated" : "unauthenticated-or-unavailable",
    authenticated: result.ok,
    identity: result.ok ? result.stdout : "",
    errorCode: result.ok
      ? ""
      : result.error
        ? "npm-unavailable"
        : "npm-auth-unavailable",
  };
}

function liveNpmTrustObservation(
  packageName,
  registry,
  cwd,
  expectedPublisher = undefined,
) {
  const result = commandResult(
    "npm",
    ["trust", "list", packageName, "--json", `--registry=${registry}`],
    { cwd },
  );
  if (!result.ok) {
    return {
      status: "unknown",
      configured: null,
      publishers: [],
      errorCode: result.error
        ? "npm-unavailable"
        : "npm-trust-query-unavailable",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "[]");
  } catch {
    return {
      status: "unknown",
      configured: null,
      publishers: [],
      errorCode: "npm-trust-response-invalid",
    };
  }
  const publishers = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.publishers)
      ? parsed.publishers
      : Array.isArray(parsed?.trustedPublishers)
        ? parsed.trustedPublishers
        : [];
  const normalizedPublishers = publishers.map(normalizedTrustedPublisher);
  const exactMatches = expectedPublisher
    ? normalizedPublishers.filter((entry) =>
        trustedPublisherMatches(entry, expectedPublisher),
      )
    : [];
  return {
    status: "observed",
    configured: expectedPublisher
      ? exactMatches.length === 1
      : normalizedPublishers.length > 0,
    exactBinding: expectedPublisher ? exactMatches.length === 1 : null,
    expectedPublisher: expectedPublisher || null,
    publishers: normalizedPublishers,
    errorCode: "",
  };
}

function liveRepositoryPermissionObservation(repository, cwd) {
  if (!repository) {
    return {
      status: "unknown",
      repository: "",
      canWrite: null,
      errorCode: "repository-unresolved",
    };
  }
  const result = commandResult("gh", ["api", `repos/${repository}`], { cwd });
  if (!result.ok) {
    return {
      status: "unknown",
      repository,
      canWrite: null,
      errorCode: result.error
        ? "gh-unavailable"
        : "github-permission-query-failed",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      status: "unknown",
      repository,
      canWrite: null,
      errorCode: "github-response-invalid",
    };
  }
  const permissions = parsed.permissions || {};
  return {
    status: "observed",
    repository,
    canWrite: Boolean(
      permissions.push || permissions.maintain || permissions.admin,
    ),
    defaultBranch: parsed.default_branch || "",
    archived: parsed.archived === true,
    visibility: parsed.visibility || (parsed.private ? "private" : "public"),
    errorCode: "",
  };
}

function liveRepositoryActionsPolicyObservation(repository, cwd) {
  if (!repository) {
    return {
      status: "unknown",
      defaultWorkflowPermissions: "",
      canApprovePullRequestReviews: null,
      errorCode: "repository-unresolved",
    };
  }
  const result = commandResult(
    "gh",
    ["api", `repos/${repository}/actions/permissions/workflow`],
    { cwd },
  );
  if (!result.ok) {
    return {
      status: "unknown",
      defaultWorkflowPermissions: "",
      canApprovePullRequestReviews: null,
      errorCode: result.error
        ? "gh-unavailable"
        : "github-actions-policy-query-failed",
    };
  }
  const parsed = safeParseJson(result.stdout);
  if (!parsed || typeof parsed !== "object") {
    return {
      status: "unknown",
      defaultWorkflowPermissions: "",
      canApprovePullRequestReviews: null,
      errorCode: "github-actions-policy-response-invalid",
    };
  }
  return {
    status: "observed",
    defaultWorkflowPermissions: String(
      parsed.default_workflow_permissions || "",
    ),
    canApprovePullRequestReviews:
      parsed.can_approve_pull_request_reviews === true,
    errorCode: "",
  };
}

function liveGeneratedWriteAuthorityObservation(repository, cwd) {
  if (!repository) {
    return {
      status: "unknown",
      configured: null,
      mode: "",
      errorCode: "repository-unresolved",
    };
  }
  const result = commandResult(
    "gh",
    ["secret", "list", "--repo", repository, "--json", "name"],
    { cwd },
  );
  if (!result.ok) {
    return {
      status: "unknown",
      configured: null,
      mode: "",
      errorCode: result.error
        ? "gh-unavailable"
        : "github-secret-metadata-query-failed",
    };
  }
  const parsed = safeParseJson(result.stdout);
  const names = new Set(
    (Array.isArray(parsed) ? parsed : [])
      .map((entry) => String(entry?.name || ""))
      .filter(Boolean),
  );
  const appConfigured =
    names.has("BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID") &&
    names.has("BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY");
  const narrowTokenConfigured =
    names.has("BUILDCHAIN_GENERATED_WRITE_TOKEN") ||
    names.has("BUILDCHAIN_PROMOTION_TOKEN");
  return {
    status: "observed",
    configured: appConfigured || narrowTokenConfigured,
    mode: appConfigured
      ? "github-app"
      : narrowTokenConfigured
        ? "narrow-token"
        : "",
    errorCode: "",
  };
}

function localToolchainObservation(cwd, publication) {
  const toolchain = publication?.toolchain || {};
  const imageRef =
    toolchain.image && toolchain.digest
      ? `${toolchain.image}@${toolchain.digest}`
      : "";
  const dockerVersion = commandResult(
    "docker",
    ["version", "--format", "{{.Client.Version}}"],
    {
      cwd,
      timeout: 5000,
    },
  );
  const image = imageRef
    ? commandResult(
        "docker",
        ["image", "inspect", imageRef, "--format", "{{index .RepoDigests 0}}"],
        {
          cwd,
          timeout: 5000,
        },
      )
    : { ok: false };
  return {
    type: toolchain.type || "",
    image: toolchain.image || "",
    digest: toolchain.digest || "",
    command: toolchain.command || "",
    identityRoot: sha256Text(
      stableJson({
        type: toolchain.type || "",
        image: toolchain.image || "",
        digest: toolchain.digest || "",
        command: toolchain.command || "",
      }),
    ),
    machineVerifiable: Boolean(
      toolchain.type === "latex-docker" &&
      toolchain.image &&
      SHA256_PATTERN.test(toolchain.digest || "") &&
      toolchain.command,
    ),
    dockerAvailable: dockerVersion.ok,
    imageAvailableLocally: image.ok,
  };
}

function paperPreflightLocalChecks({ agentEntry, provisioning, validationError, source, toolchain, runtime, lockEvaluation }) {
  return [
    ...agentEntry.checks.map((entry) => ({
      ...entry,
      blocking: true,
      scope: "local",
    })),
    {
      id: "provisioning.authority",
      status: provisioning.valid ? "pass" : "fail",
      blocking: true,
      scope: "local",
      message: provisioning.valid
        ? "Paper runtime, callers, contract lock, trust target, and policy share one exact authority root."
        : provisioning.errors.join("; "),
    },
    {
      id: "config.publication",
      status: validationError ? "fail" : "pass",
      blocking: true,
      scope: "local",
      message:
        validationError ||
        "Publication config, digest-pinned toolchain, and verify lifecycle are valid.",
    },
    {
      id: "source.exact-commit",
      status:
        GIT_SHA_PATTERN.test(source.head) && source.clean ? "pass" : "fail",
      blocking: false,
      scope: "external-mutation",
      message: !GIT_SHA_PATTERN.test(source.head)
        ? "Repository HEAD is unresolved."
        : source.clean
          ? "Source is bound to a clean exact commit."
          : "Working tree is dirty; reproducibility admits committed bytes only.",
    },
    {
      id: "toolchain.pinned",
      status: toolchain.machineVerifiable ? "pass" : "fail",
      blocking: true,
      scope: "local",
      message: toolchain.machineVerifiable
        ? "Publication toolchain identity is digest-pinned."
        : "Publication toolchain is not a qualifying digest-pinned latex-docker toolchain.",
    },
    {
      id: "runtime.exact-source",
      status:
        runtime.version && GIT_SHA_PATTERN.test(runtime.resolvedSha)
          ? "pass"
          : "fail",
      blocking: true,
      scope: "local",
      message:
        runtime.version && GIT_SHA_PATTERN.test(runtime.resolvedSha)
          ? "Buildchain runtime is bound to an exact package version and source SHA."
          : "Buildchain runtime version or exact source SHA is unresolved.",
    },
    {
      id: "runtime.contract-lock",
      status: lockEvaluation.compatible ? "pass" : "fail",
      blocking: true,
      scope: "local",
      message: lockEvaluation.compatible
        ? `Buildchain runtime contract is ${lockEvaluation.status}.`
        : `Buildchain runtime contract is not admitted: ${(lockEvaluation.reasons || []).join("; ")}`,
    },
  ];
}

function paperPreflightRepositoryChecks({ repositoryPermissions, repositoryActions, generatedWriteAuthority }) {
  return [
    {
      id: "repository.write-permission",
      status:
        repositoryPermissions.canWrite === true
          ? "pass"
          : repositoryPermissions.canWrite === false
            ? "fail"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        repositoryPermissions.canWrite === true
          ? "Current GitHub identity can write the repository."
          : repositoryPermissions.canWrite === false
            ? "Current GitHub identity cannot write the repository."
            : `Repository permission is unknown (${repositoryPermissions.errorCode}).`,
    },
    {
      id: "repository.actions-policy",
      status:
        repositoryActions.defaultWorkflowPermissions === "read" &&
        repositoryActions.canApprovePullRequestReviews === false
          ? "pass"
          : repositoryActions.status === "observed"
            ? "fail"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        repositoryActions.defaultWorkflowPermissions === "read" &&
        repositoryActions.canApprovePullRequestReviews === false
          ? "Repository defaults workflow permissions to read and disables Actions pull-request approval."
          : repositoryActions.status === "observed"
            ? "Repository Actions policy is broader than the paper provisioning authority."
            : `Repository Actions policy is unknown (${repositoryActions.errorCode}).`,
    },
    {
      id: "repository.generated-write-authority",
      status:
        generatedWriteAuthority.configured === true
          ? "pass"
          : generatedWriteAuthority.configured === false
            ? "pending"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        generatedWriteAuthority.configured === true
          ? `Generated writes use ${generatedWriteAuthority.mode} metadata; no secret value was read.`
          : generatedWriteAuthority.configured === false
            ? "No GitHub App or compatible narrow generated-write credential is configured."
            : `Generated-write authority is unknown (${generatedWriteAuthority.errorCode}).`,
    },
  ];
}

function paperPreflightPublicationChecks({ npm, status }) {
  return [
    {
      id: "npm.package",
      status:
        npm.package.exists === true
          ? "pass"
          : npm.package.exists === false
            ? "pending"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        npm.package.exists === true
          ? `npm package exists at ${npm.package.version}.`
          : npm.package.exists === false
            ? "npm package does not exist and requires bootstrap."
            : `npm package existence is unknown (${npm.package.errorCode}).`,
    },
    {
      id: "npm.trusted-publisher",
      status:
        npm.trust.configured === true
          ? "pass"
          : npm.trust.configured === false
            ? "pending"
            : "unknown",
      blocking: false,
      scope: "external-mutation",
      message:
        npm.trust.configured === true
          ? "npm reports exactly the expected repository, workflow, and environment Trusted Publisher binding."
          : npm.trust.configured === false
            ? "npm does not report the exact expected Trusted Publisher binding."
            : `npm Trusted Publisher status is unknown (${npm.trust.errorCode}).`,
    },
    {
      id: "build.reproducible",
      status:
        status.deterministicBuild.status === "qualifying" ? "pass" : "pending",
      blocking: false,
      scope: "local",
      message:
        status.deterministicBuild.status === "qualifying"
          ? "A qualifying two-clean-build receipt exists."
          : "No qualifying two-clean-build receipt exists for the exact source.",
    },
    {
      id: "release.state-conflicts",
      status: status.conflicts.length === 0 ? "pass" : "fail",
      blocking: true,
      scope: "local",
      message:
        status.conflicts.length === 0
          ? "No local release-state conflict was detected."
          : `${status.conflicts.length} release-state conflict(s) require repair.`,
    },
  ];
}

function paperPreflightNextActions({ validationError, source, lockEvaluation, npm, repositoryActions, generatedWriteAuthority, status }) {
  const actions = [];
  if (validationError) {
    actions.push({
      id: "repair-config",
      command: "buildchain validate --require-lifecycle-stages verify",
      description: validationError,
    });
  }
  if (!source.clean) {
    actions.push({
      id: "commit-source",
      command: "git status --short",
      description:
        "Review and commit the exact source before deterministic publication.",
    });
  }
  if (!lockEvaluation.compatible) {
    actions.push({
      id: "refresh-contract-lock",
      command: "buildchain paper scaffold --json",
      description:
        "Review the current runtime contract and resolve the contract-lock difference without overwriting repository files.",
    });
  }
  if (npm.package.exists === false || npm.trust.configured === false) {
    actions.push({
      id: "bootstrap-npm",
      command: "buildchain paper bootstrap npm --json",
      description:
        "Run the public-package bootstrap and Trusted Publishing dry-run.",
    });
  }
  if (
    repositoryActions.status === "observed" &&
    (repositoryActions.defaultWorkflowPermissions !== "read" ||
      repositoryActions.canApprovePullRequestReviews !== false)
  ) {
    actions.push({
      id: "constrain-repository-actions",
      command: "",
      description:
        "Set default workflow permissions to read and disable Actions pull-request approval through the repository provisioner.",
    });
  }
  if (generatedWriteAuthority.configured === false) {
    actions.push({
      id: "configure-generated-write-authority",
      command: "",
      description:
        "Install a least-privilege GitHub App or configure an equivalent narrow generated-write token without exposing its value.",
    });
  }
  if (status.deterministicBuild.status !== "qualifying") {
    actions.push({
      id: "build-paper",
      command: "buildchain paper build --execute --json",
      description: "Run the existing qualifying two-clean-build gate.",
    });
  }
  return actions;
}

export function collectPaperPreflight({
  cwd = process.cwd(),
  buildchainRoot = process.cwd(),
  buildchainVersion = "",
  buildchainRef = "v3",
  buildchainSha = "",
  registry = NPM_REGISTRY,
  offline = false,
  agentEntryMode = "contract",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const status = collectPaperStatus({ cwd: resolvedCwd });
  const provisioning = validatePaperProvisioningAuthority(resolvedCwd);
  const configResult = paperConfig(resolvedCwd);
  let validation;
  let validationError = "";
  try {
    validation = validateBuildchainConfig(resolvedCwd, { requireLifecycleStages: ["verify"] });
  } catch (error) {
    validationError = error.message;
  }
  const runtime = runtimeFacts({
    buildchainRoot, buildchainVersion,
    buildchainRef: provisioning.value?.runtime?.ref || buildchainRef, buildchainSha,
  });
  const agentEntry = collectPaperAgentEntry({ cwd: resolvedCwd, buildchainSha: runtime.resolvedSha, mode: agentEntryMode });
  const lockPath = path.resolve(resolvedCwd, PAPER_PATHS.contractLock);
  let lockEvaluation = {
    status: "missing-lock",
    compatible: false,
    drift: false,
    reasons: ["Buildchain contract lock is missing"],
  };
  try {
    const lock = readBuildchainContractLock(lockPath);
    if (lock) {
      const current = runtimeContractWorld(buildchainRoot);
      lockEvaluation = evaluateBuildchainContractLock({
        lock,
        current,
        runtimeRef: runtime.ref,
        runtimeSha: runtime.resolvedSha,
        runtimeClass: /alpha/i.test(runtime.ref) ? "alpha" : "stable",
      });
    }
  } catch (error) {
    lockEvaluation = {
      status: "invalid-lock",
      compatible: false,
      drift: false,
      reasons: [error.message],
    };
  }
  const source = {
    repositoryRoot: gitValue(resolvedCwd, ["rev-parse", "--show-toplevel"]),
    head: gitValue(resolvedCwd, ["rev-parse", "HEAD"]),
    tree: gitValue(resolvedCwd, ["rev-parse", "HEAD^{tree}"]),
    branch: gitValue(resolvedCwd, ["branch", "--show-current"]),
    clean: gitResult(resolvedCwd, ["status", "--porcelain"]).stdout === "",
  };
  const packageName = status.identity.package;
  const repository = status.identity.repository;
  const expectedPublisher = expectedPaperTrustedPublisher(provisioning.value, {
    repository, workflow: path.posix.basename(PAPER_PATHS.releaseWorkflow),
  });
  const npm =
    offline || !packageName
      ? {
          package: {
            status: "unknown",
            exists: null,
            version: "",
            registry,
            errorCode: offline ? "offline" : "package-unresolved",
          },
          auth: {
            status: "unknown",
            authenticated: null,
            identity: "",
            errorCode: offline ? "offline" : "package-unresolved",
          },
          trust: {
            status: "unknown",
            configured: null,
            publishers: [],
            errorCode: offline ? "offline" : "package-unresolved",
          },
        }
      : {
          package: liveNpmPackageObservation(packageName, registry, resolvedCwd),
          auth: liveNpmAuthObservation(registry, resolvedCwd),
          trust: liveNpmTrustObservation(packageName, registry, resolvedCwd, expectedPublisher),
        };
  const repositoryPermissions = offline
    ? {
        status: "unknown",
        repository,
        canWrite: null,
        errorCode: "offline",
      }
    : liveRepositoryPermissionObservation(repository, resolvedCwd);
  const repositoryActions = offline
    ? {
        status: "unknown",
        defaultWorkflowPermissions: "",
        canApprovePullRequestReviews: null,
        errorCode: "offline",
      }
    : liveRepositoryActionsPolicyObservation(repository, resolvedCwd);
  const generatedWriteAuthority = offline
    ? {
        status: "unknown",
        configured: null,
        mode: "",
        errorCode: "offline",
      }
    : liveGeneratedWriteAuthorityObservation(repository, resolvedCwd);
  const toolchain = localToolchainObservation(resolvedCwd, configResult.loaded?.config?.publication);
  const checks = [
    ...paperPreflightLocalChecks({ agentEntry, provisioning, validationError, source, toolchain, runtime, lockEvaluation }),
    ...paperPreflightRepositoryChecks({ repositoryPermissions, repositoryActions, generatedWriteAuthority }),
    ...paperPreflightPublicationChecks({ npm, status }),
  ];
  const blockingChecks = checks.filter(
    (entry) => entry.blocking && ["fail", "unknown"].includes(entry.status),
  );
  const externalMutationChecks = checks.filter(
    (entry) =>
      entry.scope === "external-mutation" &&
      ["fail", "pending", "unknown"].includes(entry.status),
  );
  const nextActions = paperPreflightNextActions({
    validationError, source, lockEvaluation, npm, repositoryActions, generatedWriteAuthority, status,
  });
  return {
    schemaVersion: 1,
    contract: PAPER_PREFLIGHT_CONTRACT,
    ok: blockingChecks.length === 0,
    localReady: blockingChecks.length === 0,
    readyForExternalMutation:
      blockingChecks.length === 0 && externalMutationChecks.length === 0,
    cwd: resolvedCwd,
    offline,
    identity: status.identity,
    source,
    toolchain,
    runtime: {
      ...runtime,
      admission: {
        contractLockPath: PAPER_PATHS.contractLock,
        status: lockEvaluation.status,
        compatible: lockEvaluation.compatible === true,
        drift: lockEvaluation.drift === true,
        reasons: lockEvaluation.reasons || [],
      },
    },
    provisioning: {
      path: PAPER_PATHS.provisioningAuthority,
      valid: provisioning.valid,
      authorityDigest: provisioning.value?.authorityDigest || "",
      policyDigest: provisioning.value?.policy?.policyDigest || "",
      errors: provisioning.errors,
    },
    agentEntry,
    repositoryPermissions,
    repositoryActions,
    generatedWriteAuthority,
    npm,
    deterministicBuild: status.deterministicBuild,
    releaseState: {
      transaction: status.transaction,
      conflicts: status.conflicts,
    },
    checks,
    blockingNextActions: nextActions,
    status,
  };
}

export function createPaperBuildPlan({
  cwd = process.cwd(),
  sourceSha = "",
  pullToolchain = true,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const configResult = paperConfig(resolvedCwd);
  if (configResult.error) throw new Error(configResult.error);
  const resolvedSha = sourceSha || gitValue(resolvedCwd, ["rev-parse", "HEAD"]);
  return {
    schemaVersion: 1,
    contract: PAPER_BUILD_PLAN_CONTRACT,
    ok: GIT_SHA_PATTERN.test(resolvedSha),
    cwd: resolvedCwd,
    dryRun: true,
    sourceSha: resolvedSha,
    toolchain: configResult.loaded.config.publication.toolchain,
    pullToolchain,
    output: PAPER_PATHS.reproducibilityReceipt,
    promotion: "first-byte-identical-clean-build",
    delegatesTo: "buildchain publication-artifact reproducibility --promote",
    nextActions: [
      {
        id: "execute-build",
        command: "buildchain paper build --execute --json",
        description:
          "Run two independent clean builds and promote only byte-identical qualifying outputs.",
      },
    ],
  };
}

function resolvePaperChannelRef(cwd, ref) {
  const candidates = [
    {
      observedRef: `refs/remotes/origin/${ref}`,
      observation: "origin-tracking-ref",
    },
    {
      observedRef: `refs/heads/${ref}`,
      observation: "local-branch-ref",
    },
  ];
  for (const candidate of candidates) {
    const sha = gitValue(cwd, [
      "rev-parse",
      "--verify",
      `${candidate.observedRef}^{commit}`,
    ]);
    if (GIT_SHA_PATTERN.test(sha)) {
      return {
        sha,
        ...candidate,
      };
    }
  }
  return {
    sha: "",
    observedRef: "",
    observation: "unresolved",
  };
}

export function createPaperAlphaPlan({
  cwd = process.cwd(),
  sourceRef = "",
  targetRef = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const configResult = paperConfig(resolvedCwd);
  if (configResult.error) throw new Error(configResult.error);
  const publication = configResult.loaded.config.publication;
  const parsed = parsePaperVersion(publication.version);
  const line = `v${parsed.major}.${parsed.minor}`;
  const source = sourceRef || `dev/v${parsed.major}/${line}`;
  const target = targetRef || `alpha/v${parsed.major}/${line}`;
  const repository = resolvePaperRepository(resolvedCwd);
  const sourceObservation = resolvePaperChannelRef(resolvedCwd, source);
  const targetObservation = resolvePaperChannelRef(resolvedCwd, target);
  const currentBranch = gitValue(resolvedCwd, ["branch", "--show-current"]);
  return {
    schemaVersion: 1,
    contract: PAPER_ALPHA_PLAN_CONTRACT,
    ok: Boolean(repository && source && target && source !== target),
    cwd: resolvedCwd,
    dryRun: true,
    repository,
    package: configResult.loaded.config.publish?.package || "",
    publicationVersion: parsed.version,
    channel: "alpha",
    source: {
      ref: source,
      ...sourceObservation,
    },
    target: {
      ref: target,
      ...targetObservation,
    },
    currentBranch,
    mutation: {
      kind: "github-protected-channel-pr",
      directPublish: false,
      directMerge: false,
      command: `gh pr create --repo ${repository || "<owner/repo>"} --base ${target} --head ${source}`,
    },
    gates: [
      "source is the protected dev channel for the configured semver line",
      "target is the protected alpha channel",
      "the paper release workflow seals exact bytes and uses npm OIDC",
      "this command opens a PR but never merges it or publishes directly",
    ],
    nextActions: [
      {
        id: "open-alpha-pr",
        command: "buildchain paper alpha --execute --json",
        description: "Open or reuse the protected dev-to-alpha publication PR.",
      },
    ],
  };
}

export function createPaperResumePlan({
  cwd = process.cwd(),
  buildchainRef = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const status = collectPaperStatus({ cwd: resolvedCwd });
  const transaction = status.transaction;
  if (!transaction) {
    return {
      schemaVersion: 1,
      contract: PAPER_RESUME_PLAN_CONTRACT,
      ok: false,
      cwd: resolvedCwd,
      dryRun: true,
      resumable: false,
      reason: "no-release-transaction",
      transaction: null,
      nextActions: [
        {
          id: "start-alpha",
          command: "buildchain paper alpha --json",
          description:
            "No transaction exists; plan the protected Alpha publication first.",
        },
      ],
    };
  }
  if (
    ["alpha-complete", "release-complete"].includes(
      transaction.publicationState,
    )
  ) {
    return {
      schemaVersion: 1,
      contract: PAPER_RESUME_PLAN_CONTRACT,
      ok: true,
      cwd: resolvedCwd,
      dryRun: true,
      resumable: false,
      reason: "transaction-complete",
      transaction,
      nextActions: [],
    };
  }
  const targetRef = transaction.targetRef;
  const command = [
    "gh workflow run .github/workflows/paper-release.yml",
    targetRef ? `--ref ${targetRef}` : "",
    buildchainRef ? `-f buildchain-ref=${buildchainRef}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    schemaVersion: 1,
    contract: PAPER_RESUME_PLAN_CONTRACT,
    ok: Boolean(targetRef),
    cwd: resolvedCwd,
    dryRun: true,
    resumable: Boolean(targetRef),
    reason: targetRef
      ? "rerun-sealed-paper-release"
      : "transaction-target-ref-missing",
    transaction,
    mutation: {
      kind: "github-workflow-dispatch",
      directPublish: false,
      command,
    },
    nextActions: targetRef
      ? [
          {
            id: "dispatch-resume",
            command: "buildchain paper resume --execute --json",
            description:
              "Dispatch the thin repository workflow against the exact transaction target ref.",
          },
        ]
      : [],
  };
}

function extractUrls(value, output = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      output.add(match[0].replace(/[),.;]+$/, ""));
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) extractUrls(entry, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) extractUrls(entry, output);
  }
  return output;
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function writePaperReceipt(cwd, relativePath, value) {
  const target = path.resolve(cwd, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, jsonText(value));
  return relativePath;
}

function bootstrapPackageShape({ packageName, version }) {
  return {
    name: packageName,
    version,
    private: false,
    license: "Apache-2.0",
    description: "Bootstrap package for npm Trusted Publishing setup.",
    publishConfig: {
      access: "public",
      registry: NPM_REGISTRY,
    },
  };
}

export function executePaperNpmBootstrap(options = {}) {
  return executePaperNpmBootstrapOperation(options, {
    DEFAULT_BOOTSTRAP_VERSION,
    NPM_REGISTRY,
    PAPER_NPM_BOOTSTRAP_CONTRACT,
    PAPER_PATHS,
    bootstrapPackageShape,
    commandResult,
    expectedPaperTrustedPublisher,
    extractUrls,
    fs,
    jsonText,
    liveNpmAuthObservation,
    liveNpmPackageObservation,
    liveNpmTrustObservation,
    normalizePackageName,
    normalizeRepository,
    os,
    paperConfig,
    path,
    resolvePaperRepository,
    safeParseJson,
    toPosix,
    validatePaperProvisioningAuthority,
    writePaperReceipt,
  });
}
