import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadBuildchainConfig } from "./buildchain-config.js";

export const PUBLICATION_ARTIFACT_MANIFEST_CONTRACT = "kungfu-buildchain-publication-artifact-manifest";
export const PUBLICATION_ARTIFACT_PASSPORT_CONTRACT = "kungfu-buildchain-publication-artifact-passport";

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256FilePath(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
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
    },
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
  return {
    manifest,
    passport: {
      schemaVersion: 1,
      contract: PUBLICATION_ARTIFACT_PASSPORT_CONTRACT,
      status: "passed",
      manifestDigest: `sha256:${sha256Buffer(Buffer.from(JSON.stringify(manifest, null, 2)))}`,
      source: manifest.source,
      artifacts: manifest.artifacts,
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
        ],
        outsideBoundary: [
          "paper scientific claims",
          "bibliography quality",
          "human review of publication content",
        ],
      },
      residualRisk: [
        {
          riskType: "natural-language-semantic-risk",
          trustImpact: "downgrade-warning",
          machineProvability: "not-machine-verifiable",
          agentAction: "semantic-review-required",
          note: "Buildchain verifies declared files and hashes; it does not peer-review paper claims.",
        },
      ],
    },
  };
}

export function writePublicationArtifact({
  cwd = process.cwd(),
  output = "",
  passportOutput = "",
  sourceSha = "",
  sourceBundle = true,
  sourceBundlePath = "",
  generatedAt = "",
} = {}) {
  const collected = collectPublicationArtifact({
    cwd,
    sourceSha,
    sourceBundle,
    sourceBundlePath,
    generatedAt,
  });
  const manifestOutput = output || loadBuildchainConfig(cwd).config.publication.manifestPath;
  const passportPath = passportOutput || ".buildchain/publication/publication-artifact-passport.json";
  fs.mkdirSync(path.dirname(path.resolve(cwd, manifestOutput)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(cwd, passportPath)), { recursive: true });
  fs.writeFileSync(path.resolve(cwd, manifestOutput), `${JSON.stringify(collected.manifest, null, 2)}\n`);
  fs.writeFileSync(path.resolve(cwd, passportPath), `${JSON.stringify(collected.passport, null, 2)}\n`);
  return {
    ...collected,
    manifestPath: toPosix(manifestOutput),
    passportPath: toPosix(passportPath),
  };
}
