import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadBuildchainConfig,
  validateBuildchainConfig,
} from "./buildchain-config.js";
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

export const PAPER_PATHS = Object.freeze({
  config: ".buildchain/buildchain.toml",
  versionPin: ".buildchain-version",
  contractLock: ".buildchain/contract-lock.json",
  buildWorkflow: ".github/workflows/build.yml",
  releaseWorkflow: ".github/workflows/paper-release.yml",
  reproducibilityReceipt:
    ".buildchain/publication/reproducibility-receipt.json",
  sealedBundle: ".buildchain/admitted/sealed-bundle.json",
  admission: ".buildchain/admitted/publication-admission.json",
  capability: ".buildchain/admitted/publication-capability.json",
  npmBootstrap: ".buildchain/paper/npm-bootstrap.json",
  npmTrust: ".buildchain/paper/npm-trust.json",
  provisioningAuthority: ".buildchain/paper/provisioning-authority.json",
  visibility: ".buildchain/paper/visibility.json",
});
const PAPER_SCAFFOLD_PATHS = Object.freeze([
  PAPER_PATHS.config,
  PAPER_PATHS.contractLock,
  PAPER_PATHS.versionPin,
  PAPER_PATHS.buildWorkflow,
  PAPER_PATHS.releaseWorkflow,
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

function toPosix(value) {
  return String(value || "")
    .split(path.sep)
    .join("/");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { exists: false, value: undefined, error: "" };
  }
  try {
    return {
      exists: true,
      value: JSON.parse(fs.readFileSync(filePath, "utf8")),
      error: "",
    };
  } catch (error) {
    return { exists: true, value: undefined, error: error.message };
  }
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

function normalizeRepository(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function commandResult(
  command,
  args,
  { cwd, env = process.env, timeout = 15000 } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || "",
  };
}

function gitResult(cwd, args) {
  return commandResult("git", args, { cwd });
}

function gitValue(cwd, args) {
  const result = gitResult(cwd, args);
  return result.ok ? result.stdout : "";
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

function runtimeGitSha(buildchainRoot, buildchainVersion = "") {
  const value = gitValue(buildchainRoot, ["rev-parse", "HEAD"]);
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

function runtimeAcceptedAt(buildchainRoot, sha) {
  if (!sha) return "1970-01-01T00:00:00.000Z";
  const value = gitValue(buildchainRoot, ["show", "-s", "--format=%cI", sha]);
  if (!value) return "1970-01-01T00:00:00.000Z";
  const parsed = new Date(value);
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

function texEscape(value) {
  return String(value || "")
    .replaceAll("\\", "\\textbackslash{}")
    .replaceAll("&", "\\&")
    .replaceAll("%", "\\%")
    .replaceAll("$", "\\$")
    .replaceAll("#", "\\#")
    .replaceAll("_", "\\_")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}");
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
    with:
      buildchain-ref: ${buildchainSha}
      buildchain-contract-lock-path: .buildchain/contract-lock.json
      publisher-workflow-path: .github/workflows/paper-release.yml
      toolchain-type: config
      verify-command: make check
      artifact-paths: ${JSON.stringify(artifactPaths)}
${passportInput}    secrets:
      BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID: \${{ secrets.BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID }}
      BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY: \${{ secrets.BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY }}
      BUILDCHAIN_GENERATED_WRITE_TOKEN: \${{ secrets.BUILDCHAIN_GENERATED_WRITE_TOKEN }}
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
  releaseWorkflow,
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
      release: {
        path: PAPER_PATHS.releaseWorkflow,
        sourceDigest: sha256Text(releaseWorkflow),
        reusablePath: ".github/workflows/paper-release-sealed.yml",
        reusableRef: buildchainSha,
      },
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

function scaffoldMakefile() {
  const image = `${DEFAULT_TOOLCHAIN_IMAGE}@${DEFAULT_TOOLCHAIN_DIGEST}`;
  return `.PHONY: check pdf clean

BUILDER_IMAGE := ${image}
SOURCE_DATE_EPOCH ?= 0

check:
\t@test -f paper/main.tex
\t@test -f paper/references.bib
\t@git diff --check

pdf:
\t@mkdir -p _build
\tdocker run --rm --network=none \\
\t\t-e SOURCE_DATE_EPOCH="$(SOURCE_DATE_EPOCH)" \\
\t\t-e TZ=UTC -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 -e HOME=/tmp \\
\t\t-v "$(CURDIR):/workspace" -w /workspace \\
\t\t"$(BUILDER_IMAGE)" bash -lc '${DEFAULT_TOOLCHAIN_COMMAND}'

clean:
\trm -rf _build
`;
}

function scaffoldPackageJson({ name, packageName, repository }) {
  return jsonText({
    name: packageName,
    private: true,
    description: `${name} publication source repository.`,
    repository: {
      type: "git",
      url: `git+https://github.com/${repository}.git`,
    },
    license: "Apache-2.0",
  });
}

function scaffoldReadme({ title, packageName }) {
  return `# ${title}

This repository is a Buildchain-governed publication artifact source.

## Local workflow

\`\`\`sh
buildchain paper preflight --json
buildchain paper build
buildchain paper status --json
\`\`\`

The public package identity is \`${packageName}\`. Buildchain owns reproducible
artifact generation, sealed publication, npm Trusted Publishing, and recovery;
this repository owns the paper source and review history.

See [docs/MAP.md](docs/MAP.md) for the repository map.
`;
}

function scaffoldMap() {
  return `# Repository Map

- \`paper/main.tex\`: paper source entrypoint.
- \`paper/references.bib\`: bibliography source.
- \`.buildchain/buildchain.toml\`: publication identity, toolchain, package, and lifecycle contract.
- \`.buildchain/contract-lock.json\`: accepted Buildchain runtime contract.
- \`.github/workflows/build.yml\`: thin read-only build and reproducibility caller.
- \`.github/workflows/paper-release.yml\`: thin protected sealed-release caller.

The repository does not own npm transaction logic, publication authority,
release-state recovery, or site deployment mechanics. Those remain Buildchain,
npm/GitHub, and downstream site responsibilities respectively.
`;
}

function scaffoldMainTex(title) {
  return `\\documentclass[11pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{hyperref}

\\title{${texEscape(title)}}
\\author{}
\\date{}

\\begin{document}
\\maketitle

\\begin{abstract}
Replace this paragraph with the paper abstract.
\\end{abstract}

\\section{Introduction}
Replace this section with the reviewed paper content.

\\bibliographystyle{plain}
\\bibliography{paper/references}
\\end{document}
`;
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
    runtimeAcceptedAt(buildchainRoot, buildchainSha);
  const contractLock = createBuildchainContractLock({
    buildchainRef: buildchainSha,
    resolvedSha: buildchainSha,
    contractWorld,
    acceptedAt,
  });
  const contractLockText = jsonText(contractLock);
  const buildWorkflow = scaffoldBuildWorkflow(buildchainSha);
  const releaseWorkflow = scaffoldReleaseWorkflow(buildchainSha);
  const provisioningAuthority = createPaperProvisioningAuthority({
    repository,
    packageName,
    buildchainVersion,
    buildchainSha,
    contractLock: contractLockText,
    buildWorkflow,
    releaseWorkflow,
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
    [PAPER_PATHS.releaseWorkflow, releaseWorkflow],
    [PAPER_PATHS.provisioningAuthority, jsonText(provisioningAuthority)],
    ["Makefile", scaffoldMakefile()],
    ["package.json", scaffoldPackageJson({ name, packageName, repository })],
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
    buildchainSha || runtimeGitSha(buildchainRoot, runtimeIdentity.version);
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
    buildchainSha || runtimeGitSha(buildchainRoot, buildchainVersion);
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
    buildchainRef: runtimeSha,
    resolvedSha: runtimeSha,
    contractWorld: runtimeContractWorld(buildchainRoot),
    acceptedAt:
      existingLock?.buildchain?.resolvedSha === runtimeSha
        ? existingLock.buildchain.acceptedAt
        : runtimeAcceptedAt(buildchainRoot, runtimeSha),
  });
  const contractLockText = jsonText(contractLock);
  const buildWorkflow = scaffoldBuildWorkflow(runtimeSha, {
    artifactName: config.project.name,
  });
  const releaseWorkflow = scaffoldReleaseWorkflow(runtimeSha, {
    artifactPaths: config.publication.artifactPaths.join(","),
    releasePassportProductName: config.publication.title,
  });
  const provisioningAuthority = createPaperProvisioningAuthority({
    repository,
    packageName,
    buildchainVersion: runtimeIdentity.version,
    buildchainSha: runtimeSha,
    contractLock: contractLockText,
    buildWorkflow,
    releaseWorkflow,
  });
  return new Map([
    [PAPER_PATHS.contractLock, contractLockText],
    [PAPER_PATHS.versionPin, `${runtimeIdentity.version}\n`],
    [PAPER_PATHS.buildWorkflow, buildWorkflow],
    [PAPER_PATHS.releaseWorkflow, releaseWorkflow],
    [PAPER_PATHS.provisioningAuthority, jsonText(provisioningAuthority)],
  ]);
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

function paperConfig(cwd) {
  const loaded = loadBuildchainConfig(cwd);
  if (!loaded) {
    return {
      loaded: undefined,
      error: `${PAPER_PATHS.config} is missing`,
    };
  }
  if (loaded.config.project?.type !== "publication-artifact") {
    return {
      loaded,
      error: 'project.type must be "publication-artifact"',
    };
  }
  if (!loaded.config.publication) {
    return { loaded, error: "[publication] is missing" };
  }
  return { loaded, error: "" };
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

export function collectPaperStatus({ cwd = process.cwd() } = {}) {
  const resolvedCwd = path.resolve(cwd);
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
  const blockingNextActions = [];
  if (!stateMap.scaffolded.satisfied) {
    blockingNextActions.push({
      id: "scaffold-paper",
      command: "buildchain paper scaffold --help",
      description: "Plan a no-overwrite Buildchain paper scaffold.",
    });
  } else if (!stateMap.governed.satisfied) {
    blockingNextActions.push({
      id: "restore-governance",
      command: "buildchain paper preflight --json",
      description:
        "Repair the Git/contract-lock governance checks reported by preflight.",
    });
  } else if (!stateMap["content-ready"].satisfied) {
    blockingNextActions.push({
      id: "complete-paper-content",
      command: "make check",
      description: "Add every declared paper source and metadata input.",
    });
  } else if (!deterministic) {
    blockingNextActions.push({
      id: "build-reproducible-artifact",
      command: "buildchain paper build --execute --json",
      description:
        "Run the existing two-clean-build reproducibility gate and promote exact bytes.",
    });
  } else if (
    !stateMap.bootstrapped.satisfied ||
    !stateMap["trust-bound"].satisfied
  ) {
    blockingNextActions.push({
      id: "bootstrap-npm",
      command: "buildchain paper bootstrap npm --json",
      description:
        "Inspect the dry-run npm bootstrap and Trusted Publishing handoff.",
    });
  } else if (!stateMap["alpha-complete"].satisfied) {
    blockingNextActions.push({
      id: transactionFacts.selected ? "resume-alpha" : "start-alpha",
      command: transactionFacts.selected
        ? "buildchain paper resume --json"
        : "buildchain paper alpha --json",
      description: transactionFacts.selected
        ? "Resume the exact sealed release transaction."
        : "Plan the protected dev-to-alpha publication PR.",
    });
  }
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

export function resolvePaperRepository(cwd = process.cwd()) {
  const packagePath = path.resolve(cwd, "package.json");
  const sourcePackage = readJson(packagePath).value;
  const configured =
    typeof sourcePackage?.repository === "string"
      ? sourcePackage.repository
      : sourcePackage?.repository?.url;
  const fromPackage = normalizeRepository(configured);
  if (fromPackage) return fromPackage;
  return normalizeRepository(
    gitValue(cwd, ["config", "--get", "remote.origin.url"]),
  );
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
  for (const workflow of [value.workflows?.build, value.workflows?.release]) {
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
    if (!text.includes(`buildchain-ref: ${value.runtime.resolvedSha}`)) {
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
      buildchainSha || runtimeGitSha(buildchainRoot, identity.version),
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

export function collectPaperPreflight({
  cwd = process.cwd(),
  buildchainRoot = process.cwd(),
  buildchainVersion = "",
  buildchainRef = "v3",
  buildchainSha = "",
  registry = NPM_REGISTRY,
  offline = false,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const status = collectPaperStatus({ cwd: resolvedCwd });
  const provisioning = validatePaperProvisioningAuthority(resolvedCwd);
  const configResult = paperConfig(resolvedCwd);
  let validation;
  let validationError = "";
  try {
    validation = validateBuildchainConfig(resolvedCwd, {
      requireLifecycleStages: ["verify"],
    });
  } catch (error) {
    validationError = error.message;
  }
  const runtime = runtimeFacts({
    buildchainRoot,
    buildchainVersion,
    buildchainRef: provisioning.value?.runtime?.ref || buildchainRef,
    buildchainSha,
  });
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
    repository,
    workflow: path.posix.basename(PAPER_PATHS.releaseWorkflow),
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
          package: liveNpmPackageObservation(
            packageName,
            registry,
            resolvedCwd,
          ),
          auth: liveNpmAuthObservation(registry, resolvedCwd),
          trust: liveNpmTrustObservation(
            packageName,
            registry,
            resolvedCwd,
            expectedPublisher,
          ),
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
  const toolchain = localToolchainObservation(
    resolvedCwd,
    configResult.loaded?.config?.publication,
  );
  const checks = [
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
  const blockingChecks = checks.filter(
    (entry) => entry.blocking && ["fail", "unknown"].includes(entry.status),
  );
  const externalMutationChecks = checks.filter(
    (entry) =>
      entry.scope === "external-mutation" &&
      ["fail", "pending", "unknown"].includes(entry.status),
  );
  const nextActions = [];
  if (validationError) {
    nextActions.push({
      id: "repair-config",
      command: "buildchain validate --require-lifecycle-stages verify",
      description: validationError,
    });
  }
  if (!source.clean) {
    nextActions.push({
      id: "commit-source",
      command: "git status --short",
      description:
        "Review and commit the exact source before deterministic publication.",
    });
  }
  if (!lockEvaluation.compatible) {
    nextActions.push({
      id: "refresh-contract-lock",
      command: "buildchain paper scaffold --json",
      description:
        "Review the current runtime contract and resolve the contract-lock difference without overwriting repository files.",
    });
  }
  if (npm.package.exists === false || npm.trust.configured === false) {
    nextActions.push({
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
    nextActions.push({
      id: "constrain-repository-actions",
      command: "",
      description:
        "Set default workflow permissions to read and disable Actions pull-request approval through the repository provisioner.",
    });
  }
  if (generatedWriteAuthority.configured === false) {
    nextActions.push({
      id: "configure-generated-write-authority",
      command: "",
      description:
        "Install a least-privilege GitHub App or configure an equivalent narrow generated-write token without exposing its value.",
    });
  }
  if (status.deterministicBuild.status !== "qualifying") {
    nextActions.push({
      id: "build-paper",
      command: "buildchain paper build --execute --json",
      description: "Run the existing qualifying two-clean-build gate.",
    });
  }
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

function parsePaperVersion(version) {
  const normalized = String(version || "")
    .trim()
    .replace(/^v/, "");
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    throw new Error("publication.version must be semver before planning Alpha");
  }
  return {
    version: normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
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

export function executePaperNpmBootstrap({
  cwd = process.cwd(),
  packageName = "",
  bootstrapVersion = DEFAULT_BOOTSTRAP_VERSION,
  registry = NPM_REGISTRY,
  repository = "",
  workflow = "paper-release.yml",
  environment = "",
  execute = false,
  confirmedPackage = "",
  userconfig = "",
  offline = false,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  if (registry !== NPM_REGISTRY) {
    throw new Error(
      `paper npm bootstrap requires the official registry ${NPM_REGISTRY}`,
    );
  }
  if (bootstrapVersion !== DEFAULT_BOOTSTRAP_VERSION) {
    throw new Error(
      `paper npm bootstrap version is fixed at ${DEFAULT_BOOTSTRAP_VERSION}`,
    );
  }
  const configResult = paperConfig(resolvedCwd);
  if (configResult.error) throw new Error(configResult.error);
  const name = normalizePackageName(
    packageName ||
      configResult.loaded.config.publish?.package ||
      configResult.loaded.config.publish?.mainPackage,
  );
  const repo = normalizeRepository(
    repository || resolvePaperRepository(resolvedCwd),
  );
  const provisioning = validatePaperProvisioningAuthority(resolvedCwd);
  if (!provisioning.valid) {
    throw new Error(
      `paper npm bootstrap requires a valid provisioning authority: ${provisioning.errors.join("; ")}`,
    );
  }
  const expectedPublisher = expectedPaperTrustedPublisher(provisioning.value);
  if (
    provisioning.value.package?.name !== name ||
    expectedPublisher.repository !== repo ||
    expectedPublisher.workflow !== toPosix(workflow).replace(/^\/+/, "") ||
    expectedPublisher.environment !== String(environment || "")
  ) {
    throw new Error(
      "paper npm bootstrap coordinates differ from the exact provisioning authority",
    );
  }
  if (execute && confirmedPackage !== name) {
    throw new Error(
      `real npm bootstrap requires --confirm-public-package ${name}`,
    );
  }
  if (execute && offline) {
    throw new Error("real npm bootstrap cannot run with --offline");
  }
  if (execute && (!repo || !workflow)) {
    throw new Error(
      "real npm bootstrap requires GitHub repository and workflow coordinates",
    );
  }
  const packageObservation = offline
    ? {
        status: "unknown",
        exists: null,
        version: "",
        registry,
        errorCode: "offline",
      }
    : liveNpmPackageObservation(name, registry, resolvedCwd);
  const auth = offline
    ? {
        status: "unknown",
        authenticated: null,
        identity: "",
        errorCode: "offline",
      }
    : liveNpmAuthObservation(registry, resolvedCwd);
  const plan = {
    schemaVersion: 1,
    contract: PAPER_NPM_BOOTSTRAP_CONTRACT,
    ok: true,
    dryRun: !execute,
    externalMutation: execute,
    package: {
      name,
      bootstrapVersion,
      registry,
      existsBefore: packageObservation.exists,
      observedVersion: packageObservation.version,
    },
    repository: {
      github: repo,
      workflow,
      environment,
    },
    authority: {
      digest: provisioning.value.authorityDigest,
      policyDigest: provisioning.value.policy.policyDigest,
    },
    auth: {
      authenticated: auth.authenticated,
      identity: auth.identity,
      errorCode: auth.errorCode,
    },
    publish: {
      status: packageObservation.exists === true ? "existing" : "planned",
      distTag: "bootstrap",
      access: "public",
    },
    trust: {
      status: "planned",
      urls: [],
    },
    receipts: [],
    nextActions: execute
      ? []
      : [
          {
            id: "confirm-public-bootstrap",
            command: `buildchain paper bootstrap npm --execute --confirm-public-package ${name} --json`,
            description:
              "After reviewing this dry-run, bootstrap the exact public package and configure GitHub Trusted Publishing.",
          },
        ],
  };
  if (!execute) {
    const dryRunRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-paper-bootstrap-dry-run-"),
    );
    try {
      fs.writeFileSync(
        path.join(dryRunRoot, "package.json"),
        jsonText(
          bootstrapPackageShape({
            packageName: name,
            version: bootstrapVersion,
          }),
        ),
      );
      const configArgs = userconfig ? ["--userconfig", userconfig] : [];
      const pack = commandResult(
        "npm",
        [
          "pack",
          "--dry-run",
          "--json",
          "--ignore-scripts",
          `--registry=${registry}`,
          ...configArgs,
        ],
        { cwd: dryRunRoot },
      );
      const publish = commandResult(
        "npm",
        [
          "publish",
          "--dry-run",
          "--ignore-scripts",
          "--access",
          "public",
          "--tag",
          "bootstrap",
          `--registry=${registry}`,
          ...configArgs,
        ],
        { cwd: dryRunRoot },
      );
      return {
        ...plan,
        ok: pack.ok && publish.ok,
        errorCode: !pack.ok
          ? "npm-pack-dry-run-failed"
          : !publish.ok
            ? "npm-publish-dry-run-failed"
            : "",
        dryRunChecks: {
          minimalPackageOnly: true,
          pack: {
            status: pack.ok ? "pass" : "fail",
            entryCount: (() => {
              const parsed = safeParseJson(pack.stdout);
              const value = Array.isArray(parsed) ? parsed[0] : parsed;
              return Array.isArray(value?.files) ? value.files.length : 0;
            })(),
          },
          publish: {
            status: publish.ok ? "pass" : "fail",
            registry,
            access: "public",
            distTag: "bootstrap",
          },
        },
      };
    } finally {
      fs.rmSync(dryRunRoot, { recursive: true, force: true });
    }
  }
  if (packageObservation.exists === null) {
    return {
      ...plan,
      ok: false,
      errorCode: "npm-package-status-unknown",
      publish: {
        ...plan.publish,
        status: "blocked",
      },
      trust: {
        status: "blocked",
        urls: [],
      },
      nextActions: [
        {
          id: "verify-npm-package",
          command: `npm view ${name} version --json --registry=${registry}`,
          description:
            "Resolve whether the exact public package exists before any publish mutation.",
        },
      ],
    };
  }
  if (auth.authenticated !== true) {
    return {
      ...plan,
      ok: false,
      errorCode: "npm-auth-required",
      publish: {
        ...plan.publish,
        status: "blocked",
      },
      trust: {
        status: "blocked",
        urls: [],
      },
      nextActions: [
        {
          id: "authenticate-npm",
          command: `npm whoami --registry=${registry}`,
          description:
            "Authenticate npm without sharing token contents, then rerun the exact bootstrap command.",
        },
      ],
    };
  }
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-paper-bootstrap-"),
  );
  try {
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      jsonText(
        bootstrapPackageShape({ packageName: name, version: bootstrapVersion }),
      ),
    );
    const configArgs = userconfig ? ["--userconfig", userconfig] : [];
    const pack = commandResult(
      "npm",
      [
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        `--registry=${registry}`,
        ...configArgs,
      ],
      { cwd: tempRoot },
    );
    if (!pack.ok) {
      return {
        ...plan,
        ok: false,
        errorCode: "npm-pack-dry-run-failed",
        publish: { ...plan.publish, status: "blocked" },
        trust: { status: "blocked", urls: [] },
      };
    }
    const publishDryRun = commandResult(
      "npm",
      [
        "publish",
        "--dry-run",
        "--ignore-scripts",
        "--access",
        "public",
        "--tag",
        "bootstrap",
        `--registry=${registry}`,
        ...configArgs,
      ],
      { cwd: tempRoot },
    );
    if (!publishDryRun.ok) {
      return {
        ...plan,
        ok: false,
        errorCode: "npm-publish-dry-run-failed",
        publish: { ...plan.publish, status: "blocked" },
        trust: { status: "blocked", urls: [] },
      };
    }
    let publishStatus =
      packageObservation.exists === true ? "existing" : "published";
    if (packageObservation.exists !== true) {
      const published = commandResult(
        "npm",
        [
          "publish",
          "--ignore-scripts",
          "--access",
          "public",
          "--tag",
          "bootstrap",
          `--registry=${registry}`,
          ...configArgs,
        ],
        { cwd: tempRoot, timeout: 60000 },
      );
      if (!published.ok) {
        const failure = {
          ...plan,
          ok: false,
          errorCode: "npm-publish-failed",
          publish: { ...plan.publish, status: "failed" },
          trust: { status: "blocked", urls: [] },
        };
        failure.receipts = [
          writePaperReceipt(resolvedCwd, PAPER_PATHS.npmBootstrap, failure),
        ];
        return failure;
      }
    }
    const trustArgs = [
      "trust",
      "github",
      name,
      "--repo",
      repo,
      "--file",
      workflow,
      ...(environment ? ["--env", environment] : []),
      "--allow-publish",
      "--yes",
      "--json",
      `--registry=${registry}`,
      ...configArgs,
    ];
    const trustCommand = commandResult("npm", trustArgs, {
      cwd: resolvedCwd,
      timeout: 60000,
    });
    const parsedTrust = safeParseJson(trustCommand.stdout);
    const urls = [
      ...extractUrls(
        parsedTrust || `${trustCommand.stdout}\n${trustCommand.stderr}`,
      ),
    ];
    const trustList =
      trustCommand.ok && urls.length === 0
        ? liveNpmTrustObservation(
            name,
            registry,
            resolvedCwd,
            expectedPublisher,
          )
        : {
            status: "unknown",
            configured: null,
            publishers: [],
            errorCode:
              urls.length > 0 ? "web-action-required" : "npm-trust-failed",
          };
    const trustStatus =
      trustCommand.ok && trustList.configured === true
        ? "configured"
        : urls.length > 0
          ? "action-required"
          : "failed";
    const packageAfter = liveNpmPackageObservation(name, registry, resolvedCwd);
    const packageVerified = packageAfter.exists === true;
    const receipt = {
      ...plan,
      ok: trustStatus !== "failed" && packageVerified,
      dryRun: false,
      externalMutation: true,
      errorCode:
        trustStatus === "failed"
          ? "npm-trust-failed"
          : packageVerified
            ? ""
            : "npm-package-readback-failed",
      package: {
        ...plan.package,
        existsAfter: packageAfter.exists,
        observedVersionAfter: packageAfter.version,
        readbackStatus: packageAfter.status,
      },
      publish: {
        ...plan.publish,
        status: publishStatus,
      },
      trust: {
        status: trustStatus,
        urls,
        expectedPublisher,
        exactBinding: trustList.exactBinding === true,
        publishers: trustList.publishers,
      },
      nextActions:
        trustStatus === "configured" && packageVerified
          ? [
              {
                id: "paper-preflight",
                command: "buildchain paper preflight --json",
                description:
                  "Verify package existence and Trusted Publisher binding from live read-only sources.",
              },
            ]
          : trustStatus === "action-required" && packageVerified
            ? [
                {
                  id: "complete-npm-web-action",
                  command: "",
                  description:
                    "Open the exact npm URL returned below, complete the web step, then rerun preflight.",
                  urls,
                },
              ]
            : !packageVerified
              ? [
                  {
                    id: "verify-npm-package-readback",
                    command: `npm view ${name} version --json --registry=${registry}`,
                    description:
                      "The mutation returned but the official registry did not prove package existence; do not infer success.",
                  },
                ]
              : [
                  {
                    id: "retry-npm-trust",
                    command: `buildchain paper bootstrap npm --execute --confirm-public-package ${name} --json`,
                    description:
                      "The package exists; retry only the idempotent Trusted Publisher configuration path.",
                  },
                ],
    };
    receipt.receipts = [
      writePaperReceipt(resolvedCwd, PAPER_PATHS.npmBootstrap, receipt),
    ];
    if (
      packageVerified &&
      (trustStatus === "configured" || trustStatus === "action-required")
    ) {
      receipt.receipts.push(
        writePaperReceipt(resolvedCwd, PAPER_PATHS.npmTrust, receipt),
      );
    }
    return receipt;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
