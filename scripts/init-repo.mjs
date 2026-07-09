#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BUILDCHAIN_CONFIG_PATH } from "../packages/core/buildchain-layout.js";
import { detectPackageManager, assertPackageManager } from "../packages/core/package-manager.js";

const BUILDCHAIN_WORKFLOW_REF = "kungfu-systems/buildchain/.github/workflows/.build.yml@v2";

function posixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function repoName(cwd) {
  return path.basename(path.resolve(cwd));
}

function detectOrDefaultPackageManager(cwd, requested) {
  if (requested) {
    return assertPackageManager(requested);
  }
  try {
    return detectPackageManager(cwd).name;
  } catch {
    return "pnpm";
  }
}

function packageLifecycle(manager) {
  if (manager === "npm") {
    return {
      install: "npm ci",
      build: "npm run build",
      verify: "npm run check",
    };
  }
  if (manager === "yarn") {
    return {
      install: "corepack yarn install --immutable",
      build: "corepack yarn run build",
      verify: "corepack yarn run check",
    };
  }
  return {
    install: "corepack pnpm install --frozen-lockfile",
    build: "corepack pnpm run build",
    verify: "corepack pnpm run check",
  };
}

function packageToml(cwd, manager) {
  const lifecycle = packageLifecycle(manager);
  const hasPackageJson = fs.existsSync(path.join(cwd, "package.json"));
  const versionFiles = hasPackageJson
    ? `
[[version.files]]
type = "json"
path = "package.json"
key = "version"
`
    : "";
  return `schema = 1

[project]
type = "package"
name = "${repoName(cwd)}"

[version]
required = ${hasPackageJson ? "true" : "false"}
strategy = "semver"
next = "auto"
${versionFiles}
[lifecycle.install]
command = "${lifecycle.install}"

[lifecycle.build]
command = "${lifecycle.build}"

[lifecycle.verify]
command = "${lifecycle.verify}"
`;
}

function nativeToml(cwd) {
  return `schema = 1

[project]
type = "package"
name = "${repoName(cwd)}"

[version]
required = false
strategy = "semver"
next = "auto"

[[version.files]]
type = "regex"
path = "CMakeLists.txt"
pattern = 'project\\([^)]* VERSION (?<version>[^ )]+)'
replacement = '\${version}'

[lifecycle.configure]
commands = [
  "cmake -S . -B build -DCMAKE_BUILD_TYPE=Release",
]

[lifecycle.build]
commands = [
  "cmake --build build --config Release",
]

[lifecycle.verify]
commands = [
  "ctest --test-dir build --output-on-failure",
]

[diagnostics.native]
enabled = true
sample_process_tree = false
compiler_cache = "auto"
expected_tools = ["ccache", "sccache", "clang", "cl", "cmake", "ninja"]
artifact_dirs = ["build", "dist"]
`;
}

function anchoredPackageToml(cwd, manager) {
  const lifecycle = packageLifecycle(manager);
  return `schema = 1

[project]
type = "package"
name = "${repoName(cwd)}"

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.install]
command = "${lifecycle.install}"

[lifecycle.build]
command = "${lifecycle.build}"

[lifecycle.verify]
command = "${lifecycle.verify}"
`;
}

function webSurfaceToml(cwd) {
  const name = repoName(cwd);
  return `schema = 1

[project]
type = "web-surface"
name = "${name}"
site = "${name}"

[channels.preview]
url_pattern = "https://{alias}.preview.example.com"
visibility = "ephemeral"
requires_auth = false
noindex = true

[channels.staging]
url = "https://staging.example.com"
visibility = "protected"
access_control = "managed-network"
edge_auth = "none"
noindex = true
promotable = true

[channels.production]
url = "https://example.com"
visibility = "public"
requires_auth = false
noindex = false
canonical = true

[deploy.preview]
adapter = "aws-s3-cloudfront"
artifact_path = "dist"
bucket_ref = "AWS_PREVIEW_BUCKET"
distribution_ref = "AWS_PREVIEW_DISTRIBUTION"

[deploy.staging]
adapter = "aws-s3-cloudfront"
artifact_path = "dist"
bucket_ref = "AWS_STAGING_BUCKET"
distribution_ref = "AWS_STAGING_DISTRIBUTION"

[deploy.production]
adapter = "aws-s3-cloudfront"
artifact_path = "dist"
bucket_ref = "AWS_PRODUCTION_BUCKET"
distribution_ref = "AWS_PRODUCTION_DISTRIBUTION"

[security.staging]
noindex = true
isolated_providers = true

[lifecycle.build]
command = "corepack pnpm run build"

[lifecycle.verify]
command = "corepack pnpm run check"
`;
}

function infraContractToml(cwd) {
  const name = repoName(cwd);
  return `schema = 1

[project]
type = "infra-contract"
name = "${name}"

[infra]
adapter = "manual-observed"
adoption_mode = "manual-observed"
apply = "disabled"
environment = "staging"
desired = ["infra/desired.json"]
contract = ["infra/outputs.json"]

[[consumers]]
repo = "kungfu-systems/site-example"
path = "infra/outputs.json"
source = "infra/outputs.json"

[lifecycle.verify]
command = "buildchain infra-contract --mode ci"
`;
}

function publicationArtifactToml(cwd) {
  const name = repoName(cwd);
  return `schema = 1

[project]
type = "publication-artifact"
name = "${name}"

[publication]
kind = "paper"
title = "${name}"
primary_artifact = "_build/main.pdf"
artifact_paths = ["_build/main.pdf"]
metadata_paths = ["README.md", "docs/MAP.md"]
source_paths = ["paper", "README.md", "LICENSE", "Makefile"]
site_consumers = ["papers-site"]
manifest_path = ".buildchain/publication/publication-artifact.json"
source_bundle_path = ".buildchain/publication/source.tar.gz"

[publication.toolchain]
type = "custom-command"
command = "make pdf"

[lifecycle.build]
command = "make pdf"

[lifecycle.verify]
command = "make check"
`;
}

function infraContractDesiredJson(cwd) {
  return `${JSON.stringify({
    service: repoName(cwd),
    environment: "staging",
    resources: [
      {
        kind: "static-site",
        name: repoName(cwd),
        desiredState: {
          hostname: "staging.example.com",
          accessControl: "managed-network",
          owner: "platform",
        },
      },
    ],
  }, null, 2)}\n`;
}

function infraContractOutputsJson(cwd) {
  return `${JSON.stringify({
    service: repoName(cwd),
    environment: "staging",
    observedMode: "manual-observed",
    outputs: {
      hostname: "staging.example.com",
      distributionId: "observed-distribution-id",
      bucket: "observed-bucket-name",
    },
  }, null, 2)}\n`;
}

function workflowArtifactPaths(type) {
  if (type === "infra-contract") {
    return `.buildchain/infra-contract-validate.json
        .buildchain/infra-contract-plan.json
        .buildchain/buildchain.infra-contract.json
        .buildchain/infra-contract-propagation.json
        .buildchain/infra-contract-propagation-apply.json
        .buildchain/infra-contract-evidence-bundle.json
        .buildchain/infra-contract-evidence-verification.json`;
  }
  if (type === "publication-artifact") {
    return `_build/main.pdf
        .buildchain/publication/publication-artifact.json
        .buildchain/publication/publication-artifact-passport.json
        .buildchain/publication/source.tar.gz`;
  }
  return `dist
        build/stage`;
}

function publicationWorkflowYaml() {
  return `name: Build

on:
  workflow_dispatch:
    inputs:
      buildchain-ref:
        description: "Temporary Buildchain runtime ref for trusted manual validation"
        required: false
        default: ""
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
    uses: kungfu-systems/buildchain/.github/workflows/publication-artifact.yml@v2
    with:
      buildchain-ref: \${{ inputs.buildchain-ref || '' }}
      toolchain-type: config
      verify-command: make check
      artifact-name: publication-artifact
`;
}

function workflowYaml({ type, runnerPreset, artifactName }) {
  return `name: Build

on:
  workflow_dispatch:
    inputs:
      buildchain-ref:
        description: "Temporary Buildchain runtime ref for trusted manual validation"
        required: false
        default: ""
  pull_request:
  push:
    branches:
      - "dev/**"
      - "alpha/**"
      - "release/**"
      - "publish-gate/**"

permissions:
  contents: read

jobs:
  build:
    uses: ${BUILDCHAIN_WORKFLOW_REF}
    with:
      working-directory: "."
      buildchain-ref: \${{ inputs.buildchain-ref || '' }}
      runner-preset: "${runnerPreset}"
      artifact-name-template: "${artifactName}"
      artifact-paths: |
        ${workflowArtifactPaths(type)}
`;
}

function writeIfAllowed(filePath, content, { force }) {
  if (fs.existsSync(filePath) && !force) {
    throw new Error(`${posixPath(filePath)} already exists; pass --force to overwrite`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

export function initBuildchainRepo({
  cwd = process.cwd(),
  type = "package",
  force = false,
  packageManager = "",
  runnerPreset = "github-hosted",
  artifactName = "{repo}-{version}-{platform}",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const manager = detectOrDefaultPackageManager(resolvedCwd, packageManager);
  const toml = (() => {
    if (type === "package") {
      return packageToml(resolvedCwd, manager);
    }
    if (type === "native") {
      return nativeToml(resolvedCwd);
    }
    if (type === "web-surface") {
      return webSurfaceToml(resolvedCwd);
    }
    if (type === "infra-contract") {
      return infraContractToml(resolvedCwd);
    }
    if (type === "publication-artifact") {
      return publicationArtifactToml(resolvedCwd);
    }
    if (type === "anchored-package") {
      return anchoredPackageToml(resolvedCwd, manager);
    }
    throw new Error("init --type must be one of package, native, web-surface, infra-contract, publication-artifact, or anchored-package");
  })();

  const written = [
    writeIfAllowed(path.join(resolvedCwd, BUILDCHAIN_CONFIG_PATH), toml, { force }),
    writeIfAllowed(
      path.join(resolvedCwd, ".github", "workflows", "build.yml"),
      type === "publication-artifact"
        ? publicationWorkflowYaml()
        : workflowYaml({
            type,
            runnerPreset,
            artifactName,
          }),
      { force },
    ),
  ];

  if (type === "anchored-package" && !fs.existsSync(path.join(resolvedCwd, "release.json"))) {
    written.push(writeIfAllowed(path.join(resolvedCwd, "release.json"), "{\n  \"upstream\": \"\",\n  \"version\": \"0.0.0\"\n}\n", { force }));
  }

  if (type === "infra-contract") {
    written.push(
      writeIfAllowed(path.join(resolvedCwd, "infra", "desired.json"), infraContractDesiredJson(resolvedCwd), { force }),
      writeIfAllowed(path.join(resolvedCwd, "infra", "outputs.json"), infraContractOutputsJson(resolvedCwd), { force }),
    );
  }

  return {
    schemaVersion: 1,
    type,
    cwd: resolvedCwd,
    packageManager: manager,
    workflowRef: BUILDCHAIN_WORKFLOW_REF,
    written: written.map((filePath) => posixPath(path.relative(resolvedCwd, filePath))),
  };
}

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = initBuildchainRepo({
      cwd: readArg("cwd", process.cwd()),
      type: readArg("type", "package"),
      force: process.argv.includes("--force"),
      packageManager: readArg("package-manager", ""),
      runnerPreset: readArg("runner-preset", "github-hosted"),
      artifactName: readArg("artifact-name", "{repo}-{version}-{platform}"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`init-repo: ${error.message}`);
    process.exitCode = 1;
  }
}
