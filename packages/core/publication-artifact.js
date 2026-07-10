import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadBuildchainConfig } from "./buildchain-config.js";

export const PUBLICATION_ARTIFACT_MANIFEST_CONTRACT = "kungfu-buildchain-publication-artifact-manifest";
export const PUBLICATION_ARTIFACT_PASSPORT_CONTRACT = "kungfu-buildchain-publication-artifact-passport";
export const PUBLICATION_ARTIFACT_ARCHIVE_CONTRACT = "kungfu-buildchain-publication-artifact-archive";
export const PUBLICATION_ARTIFACT_REGISTRY_CONTRACT = "kungfu-buildchain-publication-artifact-registry";
const KFD2_RESIDUAL_RISK_SCHEMA = "https://kfd.libkungfu.dev/schemas/kfd-2/trust-taxonomy.schema.json#/$defs/residualRisk";

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256FilePath(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sha256Json(value) {
  return sha256Buffer(Buffer.from(stableJson(value)));
}

function repoRelative(cwd, filePath) {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? toPosix(relative)
    : toPosix(path.resolve(filePath));
}

function listFiles(cwd, relPath) {
  const target = path.resolve(cwd, relPath);
  if (!fs.existsSync(target)) {
    return [];
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return [target];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => listFiles(cwd, path.join(repoRelative(cwd, target), entry.name)));
}

function collectFiles(cwd, paths = []) {
  const files = new Map();
  for (const relPath of paths) {
    for (const filePath of listFiles(cwd, relPath)) {
      const relative = repoRelative(cwd, filePath);
      files.set(relative, {
        path: relative,
        bytes: fs.statSync(filePath).size,
        sha256: sha256FilePath(filePath),
      });
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function gitValue(cwd, args, fallback = "") {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

function createdAt(now = new Date()) {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH || "";
  if (/^\d+$/.test(sourceDateEpoch)) {
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }
  return now.toISOString();
}

function ensureTrailingSlash(value) {
  const text = String(value || "").trim();
  return text.endsWith("/") ? text : `${text}/`;
}

function joinUrl(prefix, ...segments) {
  const base = ensureTrailingSlash(prefix);
  const suffix = segments
    .filter(Boolean)
    .map((segment) => String(segment).replace(/^\/+/, "").replace(/\\/g, "/"))
    .join("/");
  return suffix ? `${base}${suffix}` : base;
}

function versionLabel(version) {
  const text = String(version || "").trim();
  return text.startsWith("v") ? text : `v${text}`;
}

function archiveFileUrl(prefix, relPath) {
  return joinUrl(prefix, path.posix.basename(toPosix(relPath)));
}

function publicationToolchainFacts(publication) {
  const envType = String(process.env.BUILDCHAIN_PUBLICATION_TOOLCHAIN_TYPE || "").trim();
  const envToolchain = envType
    ? {
        type: envType,
        image: process.env.BUILDCHAIN_PUBLICATION_TOOLCHAIN_IMAGE || "",
        digest: process.env.BUILDCHAIN_PUBLICATION_TOOLCHAIN_DIGEST || "",
        command: process.env.BUILDCHAIN_PUBLICATION_TOOLCHAIN_COMMAND || "",
        trustClassification: envType === "latex-docker" ? "pinned-docker-toolchain" : "custom-command",
      }
    : undefined;
  const toolchain = publication.toolchain || {
    type: "custom-command",
    image: "",
    digest: "",
    command: "",
    trustClassification: "custom-command",
  };
  const resolved = envToolchain || toolchain;
  const facts = {
    type: resolved.type,
    trustClassification: resolved.trustClassification || (resolved.type === "latex-docker" ? "pinned-docker-toolchain" : "custom-command"),
    command: resolved.command || "",
    image: resolved.image || "",
    digest: resolved.digest || "",
    machineVerifiable: resolved.type === "latex-docker" && Boolean(resolved.image && resolved.digest && resolved.command),
  };
  facts.invocation = facts.type === "latex-docker"
    ? "docker-image-digest"
    : "caller-provided-command";
  return facts;
}

function publicationResidualRisk(toolchainFacts) {
  const risks = [
    {
      id: "publication-semantic-review",
      definedBy: KFD2_RESIDUAL_RISK_SCHEMA,
      riskType: "natural-language-semantic-risk",
      trustImpact: "downgrade-warning",
      machineProvability: "not-machine-verifiable",
      agentAction: "semantic-review-required",
      owner: "publication maintainers",
      reason: "Buildchain verifies declared files and hashes; it does not peer-review paper claims.",
      note: "Buildchain verifies declared files and hashes; it does not peer-review paper claims.",
    },
  ];
  if (toolchainFacts.type === "custom-command") {
    risks.push({
      id: "publication-custom-build-toolchain",
      definedBy: KFD2_RESIDUAL_RISK_SCHEMA,
      riskType: "natural-language-semantic-risk",
      trustImpact: "downgrade-warning",
      machineProvability: "not-machine-verifiable",
      agentAction: "semantic-review-required",
      owner: "publication maintainers",
      reason: "The source-to-publication build is a caller-provided command, so Buildchain records the command boundary but cannot prove a pinned compiler or LaTeX image digest.",
      note: "Use publication.toolchain.type = \"latex-docker\" with an image digest to make the PDF build toolchain machine-auditable.",
    });
  }
  return risks;
}

function publicationArchiveFacts({ loaded, publication, manifestPath, passportPath, artifacts, bundle }) {
  if (!publication.archive) {
    return undefined;
  }
  const version = String(publication.version || "").trim();
  if (!version) {
    throw new Error("publication.archive requires publication.version");
  }
  const archive = publication.archive;
  const id = archive.id || loaded.config.project?.name || "publication";
  const immutableVersionPrefix = archive.immutableUrlPrefix
    ? ensureTrailingSlash(archive.immutableUrlPrefix)
    : ensureTrailingSlash(joinUrl(archive.immutableBaseUrl, id, versionLabel(version)));
  const artifactUrlPrefix = archive.artifactUrlPrefix
    ? ensureTrailingSlash(archive.artifactUrlPrefix)
    : immutableVersionPrefix;
  return {
    contract: PUBLICATION_ARTIFACT_ARCHIVE_CONTRACT,
    id,
    version,
    appendOnly: true,
    sameVersionRepublish: "fail-on-digest-change",
    immutablePathPolicy: "do-not-sync-delete-immutable-prefixes",
    routes: {
      canonicalUrl: archive.canonicalUrl,
      latestUrl: archive.latestUrl || archive.canonicalUrl,
      latestEvidenceUrl: archive.latestEvidenceUrl,
      immutableVersionPrefix,
      immutableVersionUrl: immutableVersionPrefix,
      artifactUrlPrefix,
    },
    registry: {
      contract: PUBLICATION_ARTIFACT_REGISTRY_CONTRACT,
      path: archive.registryPath,
    },
    publicArtifacts: {
      manifest: {
        path: toPosix(manifestPath),
        url: archiveFileUrl(artifactUrlPrefix, manifestPath),
      },
      passport: {
        path: toPosix(passportPath),
        url: archiveFileUrl(artifactUrlPrefix, passportPath),
      },
      sourceBundle: bundle
        ? {
            path: bundle.path,
            url: archiveFileUrl(artifactUrlPrefix, bundle.path),
            sha256: bundle.sha256,
            bytes: bundle.bytes,
          }
        : undefined,
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        role: artifact.path === publication.primaryArtifact ? "primary" : "attachment",
        url: archiveFileUrl(artifactUrlPrefix, artifact.path),
      })),
    },
  };
}

export function createPublicationSourceBundle({
  cwd = process.cwd(),
  sourcePaths = [],
  output = ".buildchain/publication/source.tar.gz",
} = {}) {
  const outputPath = path.resolve(cwd, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const paths = sourcePaths.length > 0 ? sourcePaths : ["."];
  execFileSync("git", [
    "archive",
    "--format=tar.gz",
    `--output=${outputPath}`,
    "HEAD",
    ...paths,
  ], { cwd, stdio: "pipe" });
  return {
    path: toPosix(path.relative(cwd, outputPath)),
    bytes: fs.statSync(outputPath).size,
    sha256: sha256FilePath(outputPath),
  };
}

export function collectPublicationArtifact({
  cwd = process.cwd(),
  sourceSha = "",
  sourceBundle = true,
  sourceBundlePath = "",
  generatedAt = "",
  manifestPath = "",
  passportPath = "",
} = {}) {
  const loaded = loadBuildchainConfig(cwd);
  if (!loaded?.config?.publication) {
    throw new Error("publication artifact manifest requires [publication] in .buildchain/buildchain.toml");
  }
  if (loaded.config.project?.type !== "publication-artifact") {
    throw new Error('publication artifact manifest requires project.type = "publication-artifact"');
  }
  const publication = loaded.config.publication;
  const artifactPaths = [publication.primaryArtifact, ...publication.artifactPaths]
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
  const artifacts = collectFiles(cwd, artifactPaths);
  if (!artifacts.find((artifact) => artifact.path === publication.primaryArtifact)) {
    throw new Error(`publication primary artifact is missing: ${publication.primaryArtifact}`);
  }
  const metadata = collectFiles(cwd, publication.metadataPaths);
  const sourceFiles = collectFiles(cwd, publication.sourcePaths);
  const bundle = sourceBundle
    ? createPublicationSourceBundle({
        cwd,
        sourcePaths: publication.sourcePaths,
        output: sourceBundlePath || publication.sourceBundlePath,
      })
    : undefined;
  const resolvedSourceSha = sourceSha || gitValue(cwd, ["rev-parse", "HEAD"]);
  const sourceTreeSha = gitValue(cwd, ["rev-parse", `${resolvedSourceSha}^{tree}`]);
  const timestamp = generatedAt || createdAt();
  const toolchain = publicationToolchainFacts(publication);
  const resolvedManifestPath = manifestPath || publication.manifestPath;
  const resolvedPassportPath = passportPath || ".buildchain/publication/publication-artifact-passport.json";
  const archive = publicationArchiveFacts({
    loaded,
    publication,
    manifestPath: resolvedManifestPath,
    passportPath: resolvedPassportPath,
    artifacts,
    bundle,
  });
  const manifest = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_MANIFEST_CONTRACT,
    project: {
      name: loaded.config.project?.name || path.basename(path.resolve(cwd)),
      type: "publication-artifact",
    },
    publication: {
      kind: publication.kind,
      title: publication.title,
      version: publication.version,
      abstract: publication.abstract,
      authors: publication.authors,
      primaryArtifact: publication.primaryArtifact,
      siteConsumers: publication.siteConsumers,
      archive,
    },
    toolchain,
    source: {
      repository: gitValue(cwd, ["config", "--get", "remote.origin.url"]),
      sha: resolvedSourceSha,
      treeSha: sourceTreeSha,
      sourcePaths: publication.sourcePaths,
      sourceFiles,
      sourceBundle: bundle,
    },
    artifacts,
    metadata,
    generatedAt: timestamp,
    publishedAt: timestamp,
    reproducible: true,
    timestampPolicy: "ci-injected",
    deterministicInputs: [
      "publication source paths",
      "publication metadata paths",
      "publication primary artifact",
      "Buildchain publication contract",
      "source SHA",
      "source tree SHA",
    ],
    timestampPolicyDetails: {
      contract: "kungfu-buildchain-surface-timestamp-policy",
      timestampFields: ["generatedAt", "publishedAt"],
      timestampFieldsParticipateInArtifactDigest: false,
      artifactDigestScope: "publication artifact digests cover files and source bundle, not manifest timestamps",
    },
  };
  const manifestDigest = `sha256:${sha256Buffer(Buffer.from(JSON.stringify(manifest, null, 2)))}`;
  return {
    manifest,
    passport: {
      schemaVersion: 1,
      contract: PUBLICATION_ARTIFACT_PASSPORT_CONTRACT,
      status: "passed",
      manifestDigest,
      source: manifest.source,
      toolchain,
      artifacts: manifest.artifacts,
      publicationArchive: archive
        ? {
            contract: archive.contract,
            id: archive.id,
            version: archive.version,
            routes: archive.routes,
            registry: archive.registry,
            publicArtifacts: {
              manifest: {
                ...archive.publicArtifacts.manifest,
                sha256: manifestDigest.replace(/^sha256:/, ""),
              },
              passport: archive.publicArtifacts.passport,
              sourceBundle: archive.publicArtifacts.sourceBundle,
              artifacts: archive.publicArtifacts.artifacts,
            },
            appendOnly: archive.appendOnly,
            sameVersionRepublish: archive.sameVersionRepublish,
            immutablePathPolicy: archive.immutablePathPolicy,
          }
        : undefined,
      responsibility: {
        producer: "publication repository",
        renderer: "site repository",
        buildchain: "artifact contract, manifest, source bundle, and evidence generation",
      },
      auditBoundary: {
        machineVerified: [
          "declared publication artifact files exist",
          "declared publication metadata files exist",
          "declared publication source files are hashed",
          "source bundle digest is recorded",
          toolchain.machineVerifiable
            ? "publication PDF build toolchain image digest is declared"
            : "publication build command boundary is recorded",
        ],
        outsideBoundary: [
          "paper scientific claims",
          "bibliography quality",
          "human review of publication content",
        ],
      },
      residualRisk: publicationResidualRisk(toolchain),
    },
  };
}

function publicationArchiveRecord({ collected, manifestPath, passportPath, registryPath, generatedAt }) {
  const archive = collected.manifest.publication.archive;
  if (!archive) {
    return undefined;
  }
  const manifestDigest = sha256FilePath(manifestPath);
  const passportDigest = sha256FilePath(passportPath);
  const immutableEvidence = {
    version: archive.version,
    source: {
      sha: collected.manifest.source.sha,
      treeSha: collected.manifest.source.treeSha,
      sourceBundle: archive.publicArtifacts.sourceBundle,
    },
    routes: archive.routes,
    artifacts: archive.publicArtifacts.artifacts.map((artifact) => ({
      path: artifact.path,
      role: artifact.role,
      url: artifact.url,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
    metadata: collected.manifest.metadata,
    toolchain: collected.manifest.toolchain,
  };
  const immutableDigest = sha256Json(immutableEvidence);
  const record = {
    version: archive.version,
    status: "published",
    publishedAt: generatedAt || collected.manifest.publishedAt,
    immutableDigest: `sha256:${immutableDigest}`,
    source: {
      repository: collected.manifest.source.repository,
      sha: collected.manifest.source.sha,
      treeSha: collected.manifest.source.treeSha,
      sourceBundle: archive.publicArtifacts.sourceBundle,
    },
    routes: archive.routes,
    artifacts: archive.publicArtifacts.artifacts,
    metadata: collected.manifest.metadata,
    manifest: {
      ...archive.publicArtifacts.manifest,
      sha256: manifestDigest,
    },
    passport: {
      ...archive.publicArtifacts.passport,
      sha256: passportDigest,
    },
    immutableEvidenceSha256: immutableDigest,
  };
  record.recordSha256 = sha256Json({ ...record, recordSha256: undefined });
  return {
    registryPath: archive.registry.path || registryPath,
    record,
  };
}

function immutablePublicationRecord(record = {}) {
  const { publishedAt: _publishedAt, latestObservedAt: _latestObservedAt, recordSha256: _recordSha256, ...immutable } = record;
  return immutable;
}

function readVerifiedPublicationRegistry(registryPath) {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (registry.contract !== PUBLICATION_ARTIFACT_REGISTRY_CONTRACT) {
    throw new Error(`publication archive registry has unsupported contract: ${registry.contract || "(missing)"}`);
  }
  const expectedDigest = sha256Json({ ...registry, registrySha256: undefined });
  if (registry.registrySha256 !== expectedDigest) {
    throw new Error(`publication archive registry digest mismatch for ${registryPath}: expected ${expectedDigest}, got ${registry.registrySha256 || "(missing)"}`);
  }
  if (!Array.isArray(registry.versions)) throw new Error(`publication archive registry versions must be an array: ${registryPath}`);
  return registry;
}

function mergePublicationRegistryVersions({ registries = [], publicationId }) {
  const versions = new Map();
  for (const registry of registries) {
    if (registry.publication?.id !== publicationId) {
      throw new Error(`publication archive registry id mismatch: expected ${publicationId}, got ${registry.publication?.id || "(missing)"}`);
    }
    if (registry.historyPolicy === "cumulative-authenticated-hydration") {
      const declaredVersions = new Set(registry.versions.map((record) => String(record?.version || "")));
      const missingVersions = [...versions.keys()].filter((version) => !declaredVersions.has(version));
      if (missingVersions.length > 0) throw new Error(`cumulative publication archive registry dropped accepted versions: ${missingVersions.join(", ")}`);
    }
    for (const record of registry.versions) {
      const version = String(record?.version || "").trim();
      if (!version) throw new Error("publication archive registry record is missing version");
      const existing = versions.get(version);
      if (!existing) {
        versions.set(version, record);
        continue;
      }
      if (existing.immutableDigest !== record.immutableDigest || stableJson(immutablePublicationRecord(existing)) !== stableJson(immutablePublicationRecord(record))) {
        throw new Error(`publication archive version ${version} changed across accepted registries: ${existing.immutableDigest || "(missing)"} != ${record.immutableDigest || "(missing)"}`);
      }
      const latestObservedAt = [existing.latestObservedAt, record.latestObservedAt].filter(Boolean).sort().at(-1);
      versions.set(version, latestObservedAt ? { ...existing, latestObservedAt } : existing);
    }
  }
  return [...versions.values()];
}

function updatePublicationArchiveRegistry({ cwd, collected, manifestPath, passportPath, registryOutput, registryInputs = [], generatedAt }) {
  const archive = collected.manifest.publication.archive;
  if (!archive) {
    return undefined;
  }
  const registryPath = path.resolve(cwd, registryOutput || archive.registry.path);
  const { record } = publicationArchiveRecord({
    collected,
    manifestPath,
    passportPath,
    registryPath,
    generatedAt,
  });
  let registry = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_REGISTRY_CONTRACT,
    publication: {
      id: archive.id,
      kind: collected.manifest.publication.kind,
      title: collected.manifest.publication.title,
      canonicalUrl: archive.routes.canonicalUrl,
      latestUrl: archive.routes.latestUrl,
      latestEvidenceUrl: archive.routes.latestEvidenceUrl,
      siteConsumers: collected.manifest.publication.siteConsumers,
    },
    appendOnly: true,
    historyPolicy: "cumulative-authenticated-hydration",
    sameVersionRepublish: "fail-on-digest-change",
    immutablePathPolicy: archive.immutablePathPolicy,
    versions: [],
  };
  const inputPaths = [...registryInputs.map((entry) => path.resolve(cwd, entry)), ...(fs.existsSync(registryPath) ? [registryPath] : [])];
  const versions = mergePublicationRegistryVersions({
    registries: inputPaths.map(readVerifiedPublicationRegistry),
    publicationId: archive.id,
  });
  const existingIndex = versions.findIndex((entry) => entry.version === record.version);
  if (existingIndex !== -1) {
    const existing = versions[existingIndex];
    if (existing.immutableDigest !== record.immutableDigest) {
      throw new Error(
        `publication archive version ${record.version} is immutable: existing digest ${existing.immutableDigest}, new digest ${record.immutableDigest}`,
      );
    }
    versions[existingIndex] = {
      ...existing,
      latestObservedAt: generatedAt || collected.manifest.publishedAt,
    };
  } else {
    versions.push(record);
  }
  registry = {
    ...registry,
    publication: {
      ...registry.publication,
      id: archive.id,
      kind: collected.manifest.publication.kind,
      title: collected.manifest.publication.title,
      canonicalUrl: archive.routes.canonicalUrl,
      latestUrl: archive.routes.latestUrl,
      latestEvidenceUrl: archive.routes.latestEvidenceUrl,
      siteConsumers: collected.manifest.publication.siteConsumers,
    },
    versions: versions.sort((left, right) => left.version.localeCompare(right.version)),
  };
  registry.registrySha256 = sha256Json({ ...registry, registrySha256: undefined });
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, stableJson(registry));
  return {
    path: toPosix(path.relative(cwd, registryPath)),
    sha256: sha256FilePath(registryPath),
    record,
    registry,
  };
}

export function writePublicationArtifact({
  cwd = process.cwd(),
  output = "",
  passportOutput = "",
  registryOutput = "",
  registryInputs = [],
  sourceSha = "",
  sourceBundle = true,
  sourceBundlePath = "",
  generatedAt = "",
} = {}) {
  const loaded = loadBuildchainConfig(cwd);
  const manifestOutput = output || loaded.config.publication.manifestPath;
  const passportPath = passportOutput || ".buildchain/publication/publication-artifact-passport.json";
  const collected = collectPublicationArtifact({
    cwd,
    sourceSha,
    sourceBundle,
    sourceBundlePath,
    generatedAt,
    manifestPath: manifestOutput,
    passportPath,
  });
  fs.mkdirSync(path.dirname(path.resolve(cwd, manifestOutput)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(cwd, passportPath)), { recursive: true });
  fs.writeFileSync(path.resolve(cwd, manifestOutput), `${JSON.stringify(collected.manifest, null, 2)}\n`);
  fs.writeFileSync(path.resolve(cwd, passportPath), `${JSON.stringify(collected.passport, null, 2)}\n`);
  const registry = updatePublicationArchiveRegistry({
    cwd,
    collected,
    manifestPath: path.resolve(cwd, manifestOutput),
    passportPath: path.resolve(cwd, passportPath),
    registryOutput,
    registryInputs,
    generatedAt,
  });
  return {
    ...collected,
    manifestPath: toPosix(manifestOutput),
    passportPath: toPosix(passportPath),
    registryPath: registry?.path,
    registry,
  };
}
