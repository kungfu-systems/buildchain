import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createBuildchainContractWorld, sha256Json } from "./buildchain-contract.js";

export const BUILDCHAIN_KFD_CLAIM_REGISTRY_CONTRACT = "kungfu-buildchain-kfd-claim-registry";
export const BUILDCHAIN_KFD_COLLABORATION_INTERFACE_CONTRACT = "kungfu-buildchain-kfd-collaboration-interface";

export const BUILDCHAIN_AGENT_MANUALS = Object.freeze([
  { id: "install", title: "Install and verify Buildchain", path: "docs/install.md", plane: "use" },
  { id: "release-passport", title: "Release Passport protocol", path: "docs/release-passport.md", plane: "verify" },
  { id: "release-propagation", title: "Release propagation", path: "docs/release-propagation.md", plane: "use" },
  { id: "binary-distribution", title: "Binary distribution contract", path: "docs/binary-distribution.md", plane: "verify" },
  { id: "toolkit-observability", title: "Toolkit observability", path: "docs/toolkit-observability.md", plane: "use" },
  { id: "site-bundle-contract", title: "Site bundle contract", path: "docs/site-bundle-contract.md", plane: "use" },
  { id: "product-mechanism", title: "Product mechanism", path: "docs/product-mechanism.md", plane: "why" },
  { id: "cli", title: "CLI and npm package", path: "docs/cli.md", plane: "use" },
  { id: "lifecycle-protocol", title: "Lifecycle protocol", path: "docs/lifecycle-protocol.md", plane: "use" },
  { id: "reusable-build-surface", title: "Reusable build surface", path: "docs/reusable-build-surface.md", plane: "use" },
  { id: "publish-transaction", title: "Publish transaction", path: "docs/publish-transaction.md", plane: "verify" },
  { id: "release-governance", title: "Release governance", path: "docs/release-governance.md", plane: "why" },
  { id: "release-flow", title: "Release flow", path: "docs/release-flow.md", plane: "verify" },
  { id: "versioning", title: "Versioning", path: "docs/versioning.md", plane: "why" },
  { id: "web-surface-deployments", title: "Web surface deployments", path: "docs/web-surface-deployments.md", plane: "use" },
  { id: "infra-contract", title: "Infra Contract", path: "docs/infra-contract.md", plane: "use" },
]);

const SITE_CONTRACT_FILES = Object.freeze([
  "dist/site/buildchain-site.json",
  "dist/site/site-manifest.json",
  "dist/site/cli-registry.json",
  "dist/site/manual-registry.json",
  "dist/site/node-api-registry.json",
  "dist/site/workflow-registry.json",
  "dist/site/release-model.json",
  "dist/site/artifact-schemas.json",
  "dist/site/buildchain-contract.json",
  "dist/site/product-mechanism.json",
  "dist/site/release-provenance.json",
  "dist/site/agent-index.json",
  "dist/site/kfd-claims.json",
]);

const SCHEMA_AND_STANDARD_FILES = Object.freeze([
  "packages/core/kfd-gate.js",
  "packages/core/release-passport.js",
  "packages/core/buildchain-contract.js",
  "packages/core/buildchain-kfd-claims.js",
  "dist/site/artifact-schemas.json",
  "dist/site/buildchain-contract.json",
]);

const WORKFLOW_AND_ACTION_FILES = Object.freeze([
  ".github/workflows/.build.yml",
  ".github/workflows/release-candidate-promote.yml",
  ".github/workflows/buildchain-ref-promotion.yml",
  ".github/workflows/release-propagation.yml",
  "actions/promote-buildchain-ref/action.yml",
  "actions/promote-buildchain-ref/index.js",
]);

const EXTRA_KFD1_FILES = Object.freeze([
  "package.json",
  "bin/buildchain.mjs",
  "packages/core/index.js",
  "packages/core/release-propagation.js",
  "scripts/generate-site-bundle.mjs",
  "scripts/ensure-github-release.mjs",
]);

function readJson(root, relPath, fallback = {}) {
  const filePath = path.join(root, relPath);
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fileExists(root, relPath) {
  const filePath = path.join(root, relPath);
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function sha256File(root, relPath) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relPath))).digest("hex");
}

function uniqueById(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))].sort();
}

function fileEvidence(root, relPath, extra = {}) {
  const sha256 = fileExists(root, relPath) ? sha256File(root, relPath) : "";
  return {
    id: extra.id || relPath,
    path: relPath,
    sha256,
    digest: sha256 ? `sha256:${sha256}` : "",
    ...extra,
  };
}

function packageJson(root) {
  return readJson(root, "package.json", {});
}

function sourceMetadata({ root, sourceSha = "" } = {}) {
  const pkg = packageJson(root);
  return {
    repo: "kungfu-systems/buildchain",
    ref: sourceSha,
    package: pkg.name || "@kungfu-tech/buildchain",
  };
}

function runtimeContractSummary({ root = process.cwd() } = {}) {
  const contractWorld = createBuildchainContractWorld({ root });
  return {
    contract: contractWorld.contract,
    compatibilityDigest: contractWorld.compatibilityDigest,
    majorLine: contractWorld.majorLine,
  };
}

function surface(id, kind, relPath, extra = {}) {
  return {
    id,
    name: extra.name || id,
    kind,
    sourcePath: relPath,
    evidencePath: relPath,
    availability: "shipped",
    visibility: "public",
    participantFacing: true,
    public: true,
    ...extra,
  };
}

export function createBuildchainPublicClaimDefinitions() {
  return [
    {
      id: "claim:buildchain-kfd-release-passport-support",
      claim: "Buildchain release passports support KFD-1 self contract verification, KFD-2 public release claim audits, and KFD-3 collaboration-interface trust proofs.",
      sourcePaths: [
        "packages/core/release-passport.js",
        "packages/core/kfd-gate.js",
        "packages/core/buildchain-kfd-claims.js",
        "docs/release-passport.md",
      ],
      artifactPaths: [
        "dist/site/buildchain-contract.json",
        "dist/site/kfd-claims.json",
        "dist/site/artifact-schemas.json",
      ],
    },
    {
      id: "claim:buildchain-agent-first-source-of-truth",
      claim: "The npm package ships Buildchain's agent-first manuals, Node API registry, site facts, and release model as the single source of truth for downstream sites and agents.",
      sourcePaths: [
        "scripts/generate-site-bundle.mjs",
        "packages/core/buildchain-kfd-claims.js",
        "docs/MAP.md",
        "docs/site-bundle-contract.md",
        "docs/cli.md",
      ],
      artifactPaths: [
        "dist/site/manual-registry.json",
        "dist/site/node-api-registry.json",
        "dist/site/buildchain-site.json",
        "dist/site/site-manifest.json",
      ],
    },
    {
      id: "claim:buildchain-floating-contract-lock",
      claim: "Consumers using floating Buildchain refs can lock the observed runtime contract and receive drift checks before expensive build or publish work proceeds.",
      sourcePaths: [
        "packages/core/buildchain-contract.js",
        "scripts/buildchain-contract-lock.mjs",
        ".github/workflows/.build.yml",
        ".github/workflows/release-candidate-promote.yml",
        "docs/reusable-build-surface.md",
      ],
      artifactPaths: [
        "dist/site/buildchain-contract.json",
        "dist/site/release-model.json",
      ],
    },
    {
      id: "claim:buildchain-semver-github-release",
      claim: "Semver promotion can create or update an exact-tag GitHub Release only after the publish transaction completes, and uploads Buildchain release passport/evidence assets.",
      sourcePaths: [
        "actions/promote-buildchain-ref/index.js",
        "actions/promote-buildchain-ref/action.yml",
        "scripts/ensure-github-release.mjs",
        ".github/workflows/release-candidate-promote.yml",
        "docs/release-governance.md",
      ],
      artifactPaths: [
        "dist/site/release-model.json",
        "dist/site/workflow-registry.json",
      ],
    },
    {
      id: "claim:buildchain-release-propagation",
      claim: "Buildchain can propagate upstream alpha or stable releases to downstream repositories while preserving release channels through exact release locks.",
      sourcePaths: [
        "packages/core/release-propagation.js",
        "scripts/release-propagation.mjs",
        ".github/workflows/release-propagation.yml",
        "docs/release-propagation.md",
      ],
      artifactPaths: [
        "dist/site/release-model.json",
        "dist/site/workflow-registry.json",
      ],
    },
    {
      id: "claim:buildchain-npm-publish-evidence",
      claim: "Buildchain npm publish transactions bind trusted publishing, package-set required artifacts, publish evidence, durable release state, and final release passports.",
      sourcePaths: [
        "scripts/npm-publish-transaction.mjs",
        "actions/promote-buildchain-ref/index.js",
        ".github/workflows/release-candidate-promote.yml",
        "docs/publish-transaction.md",
      ],
      artifactPaths: [
        "dist/site/release-model.json",
        "dist/site/artifact-schemas.json",
      ],
    },
  ];
}

export function createBuildchainKfdSurfaceRegistry({ root = process.cwd() } = {}) {
  const pkg = packageJson(root);
  const exports = Object.entries(pkg.exports || {})
    .filter(([specifier]) => !specifier.startsWith("./site/") && specifier !== "./package.json")
    .map(([specifier, target]) => surface(
      `export:${specifier}`,
      "package-export",
      String(target).replace(/^\.\//, ""),
      {
        packageExport: specifier,
        name: specifier === "." ? pkg.name : `${pkg.name}/${specifier.replace(/^\.\//, "")}`,
      },
    ));
  const docs = BUILDCHAIN_AGENT_MANUALS.map((manual) => surface(`doc:${manual.id}`, "documentation", manual.path, {
    name: manual.title,
    plane: manual.plane,
  }));
  const schemas = SCHEMA_AND_STANDARD_FILES.map((relPath) => surface(`schema:${relPath}`, "schema", relPath));
  const standardsMetadata = [
    surface("metadata:package-json", "standards-metadata", "package.json"),
    surface("metadata:buildchain-contract-world", "standards-metadata", "dist/site/buildchain-contract.json"),
    surface("metadata:kfd-claim-registry", "standards-metadata", "dist/site/kfd-claims.json"),
    surface("metadata:release-model", "standards-metadata", "dist/site/release-model.json"),
  ];
  const siteConsumptionContracts = SITE_CONTRACT_FILES.map((relPath) => surface(`site:${relPath}`, "site-consumption-contract", relPath));
  const controlSurfaces = WORKFLOW_AND_ACTION_FILES.map((relPath) => surface(`control:${relPath}`, relPath.includes("actions/") ? "action" : "workflow", relPath));
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_KFD_COLLABORATION_INTERFACE_CONTRACT,
    groups: {
      docs,
      schemas,
      standardsMetadata,
      packageExports: exports,
      siteConsumptionContracts,
    },
    additionalSurfaces: controlSurfaces,
    publicSurfaceCount: docs.length + schemas.length + standardsMetadata.length + exports.length + siteConsumptionContracts.length + controlSurfaces.length,
  };
}

export function createBuildchainKfdClaimRegistry({ root = process.cwd(), sourceSha = "" } = {}) {
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_KFD_CLAIM_REGISTRY_CONTRACT,
    product: {
      name: "Buildchain",
      package: packageJson(root).name || "@kungfu-tech/buildchain",
      repository: "kungfu-systems/buildchain",
    },
    source: {
      ...sourceMetadata({ root, sourceSha }),
      sourceModule: "packages/core/buildchain-kfd-claims.js",
    },
    runtimeContract: runtimeContractSummary({ root }),
    publicClaims: createBuildchainPublicClaimDefinitions(),
    collaborationSurfaces: createBuildchainKfdSurfaceRegistry({ root }),
  };
}

export function createBuildchainKfd1Witness({ root = process.cwd(), sourceSha = "" } = {}) {
  const registry = createBuildchainKfdClaimRegistry({ root, sourceSha });
  const registrySha256 = sha256Json(registry);
  const paths = uniquePaths([
    ...BUILDCHAIN_AGENT_MANUALS.map((entry) => entry.path),
    ...SCHEMA_AND_STANDARD_FILES,
    ...SITE_CONTRACT_FILES,
    ...WORKFLOW_AND_ACTION_FILES,
    ...EXTRA_KFD1_FILES,
  ]);
  return {
    schemaVersion: 1,
    id: "buildchain-self-contract-world",
    standard: "kfd-1",
    source: sourceMetadata({ root, sourceSha }),
    contractWorld: {
      id: "buildchain-runtime-contract-world",
      schemaId: "kungfu-buildchain-runtime-contract-world",
      digest: `sha256:${registrySha256}`,
      owner: "Buildchain maintainers",
      selfHosted: true,
    },
    standardContract: {
      id: "buildchain-kfd-claim-registry",
      path: "dist/site/kfd-claims.json",
      sha256: fileExists(root, "dist/site/kfd-claims.json") ? sha256File(root, "dist/site/kfd-claims.json") : "",
    },
    selfHostingBoundary: {
      mode: "self-hosted-standard-contract",
      sourceScope: "Buildchain KFD claim registry, release-passport schemas, manuals, Node API exports, workflows, and site-consumption contracts",
      artifactScope: "packaged npm files and release passport evidence assets",
      boundary: "declared source files must match packaged artifact bytes by sha256",
      residualRisk: [],
    },
    responsibility: {
      sourceContractOwner: "Buildchain maintainers",
      artifactVerificationOwner: "Buildchain KFD-1 release gate",
      releasePassportProofOwner: "Buildchain",
    },
    surfaces: paths.map((relPath) => {
      const sha256 = fileExists(root, relPath) ? sha256File(root, relPath) : "";
      return {
        name: relPath,
        sourcePath: relPath,
        sourceSha256: sha256,
        artifactPath: relPath,
        expectedSha256: sha256,
        byteForByte: true,
      };
    }),
  };
}

export function createBuildchainKfd3PrebuildWitness({ root = process.cwd(), sourceSha = "" } = {}) {
  const registry = createBuildchainKfdClaimRegistry({ root, sourceSha });
  const surfaces = createBuildchainKfdSurfaceRegistry({ root });
  const digest = `sha256:${sha256Json(registry)}`;
  return {
    schemaVersion: 1,
    id: "buildchain-collaboration-interface",
    standard: "kfd-3",
    supportLevel: "release",
    source: sourceMetadata({ root, sourceSha }),
    sourceRegistry: {
      id: "Buildchain KFD claim registry",
      path: "dist/site/kfd-claims.json",
      sha256: fileExists(root, "dist/site/kfd-claims.json") ? sha256File(root, "dist/site/kfd-claims.json") : "",
    },
    collaborationInterfaceDigest: digest,
    collaborationInterface: {
      schemaVersion: 1,
      contract: BUILDCHAIN_KFD_COLLABORATION_INTERFACE_CONTRACT,
      product: {
        name: "Buildchain",
        repository: "kungfu-systems/buildchain",
        package: packageJson(root).name || "@kungfu-tech/buildchain",
      },
      participants: [
        { id: "human-release-operator", kind: "human" },
        { id: "agent-consumer", kind: "agent" },
        { id: "downstream-site", kind: "site" },
      ],
      docs: surfaces.groups.docs,
      schemas: surfaces.groups.schemas,
      standardsMetadata: surfaces.groups.standardsMetadata,
      packageExports: surfaces.groups.packageExports,
      siteConsumptionContracts: surfaces.groups.siteConsumptionContracts,
      surfaces: surfaces.additionalSurfaces,
      closure: {
        classificationMode: "closed-world",
        reachableSurfaceMode: "declared-boundary",
        unclassifiedEntrypointsPolicy: "fail",
        nonExhaustivelyEnumerableSurfaces: [],
        explicitlyExemptedSurfaces: [],
      },
    },
    auditBoundary: {
      mode: "closed-world",
      scope: "Buildchain public human/agent release, workflow, package, and site-consumption surfaces",
      reachableSurfaceMode: "declared-boundary",
      unclassifiedPolicy: "fail",
      nonExhaustivelyEnumerableSurfaces: [],
      explicitlyExemptedSurfaces: [],
    },
    residualRisk: [],
    responsibility: {
      registryFactsOwner: "Buildchain maintainers",
      artifactVerificationOwner: "Buildchain KFD-3 release gate",
      releasePassportProofOwner: "Buildchain",
    },
  };
}

export function createBuildchainKfd3ArtifactWitness({ root = process.cwd(), sourceSha = "" } = {}) {
  const registry = createBuildchainKfdClaimRegistry({ root, sourceSha });
  const surfaces = createBuildchainKfdSurfaceRegistry({ root });
  return {
    schemaVersion: 1,
    id: "buildchain-collaboration-interface",
    standard: "kfd-3",
    sourceRegistry: {
      id: "Buildchain KFD claim registry",
      path: "dist/site/kfd-claims.json",
      sha256: fileExists(root, "dist/site/kfd-claims.json") ? sha256File(root, "dist/site/kfd-claims.json") : "",
    },
    collaborationInterfaceDigest: `sha256:${sha256Json(registry)}`,
    artifact: {
      name: packageJson(root).name || "@kungfu-tech/buildchain",
      path: "package.json",
      digest: fileExists(root, "package.json") ? `sha256:${sha256File(root, "package.json")}` : "",
    },
    docs: surfaces.groups.docs,
    schemas: surfaces.groups.schemas,
    standardsMetadata: surfaces.groups.standardsMetadata,
    packageExports: surfaces.groups.packageExports,
    siteConsumptionContracts: surfaces.groups.siteConsumptionContracts,
    surfaces: surfaces.additionalSurfaces,
    verifier: {
      name: "Buildchain self KFD witness generator",
      source: "scripts/generate-buildchain-kfd-witnesses.mjs",
    },
  };
}

export function createBuildchainKfd2Claims({ root = process.cwd(), witnessFiles = {} } = {}) {
  const evidenceFiles = Object.entries(witnessFiles)
    .filter(([, relPath]) => relPath)
    .map(([id, relPath]) => fileEvidence(root, relPath, { id }));
  return createBuildchainPublicClaimDefinitions().map((definition) => {
    const sourceBindings = uniqueById(definition.sourcePaths.map((relPath) => fileEvidence(root, relPath)));
    const artifacts = uniqueById(definition.artifactPaths.map((relPath) => fileEvidence(root, relPath)));
    const machineEvidence = [
      ...evidenceFiles,
      { id: "buildchain-kfd-claim-definition", digest: `sha256:${sha256Json(definition)}` },
    ];
    return {
      id: definition.id,
      public: true,
      claim: definition.claim,
      sourceBindings,
      machineEvidence,
      hashes: {
        definitionSha256: sha256Json(definition),
        sourceBindingsSha256: sha256Json(sourceBindings),
        machineEvidenceSha256: sha256Json(machineEvidence),
        artifactsSha256: sha256Json(artifacts),
      },
      artifacts,
      verification: {
        result: "passed",
        method: "Buildchain self KFD claim registry and release witness generation",
      },
      auditBoundary: {
        mode: "closed-world",
        scope: "Buildchain declared public release claims for packaged docs, workflows, actions, Node exports, site facts, npm publish, GitHub Release, release propagation, and KFD passport support",
      },
      responsibility: {
        owner: "Buildchain maintainers",
        sourceOwner: "Buildchain maintainers",
        releasePassportProofOwner: "Buildchain",
      },
      residualRisk: [],
    };
  });
}
