import { assertSha } from "./selection.js";
import { digestFileSync } from "./transport.js";
import { execFileSync } from "node:child_process";
import { domainContentRoot } from "../../contracts/canonical-contracts.js";
import {
  domainPublicationQualificationRoot,
  validatePublicationQualificationReceipt,
} from "../../publication/publication-qualification.js";
import fs from "node:fs";
import path from "node:path";
export function outputPath(filePath) {
  const relative = path
    .relative(process.cwd(), filePath)
    .split(path.sep)
    .join("/");
  return relative.startsWith("../") || relative === ".." ? filePath : relative;
}

export function splitPatterns(value = "") {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function artifactPatternToRegExp(pattern) {
  return new RegExp(
    `^${String(pattern).split("*").map(escapeRegExp).join(".*")}$`,
  );
}

export function selectPayloadArtifacts({
  artifacts = [],
  artifactName = "",
  sourceSha = "",
  patterns = [],
} = {}) {
  const prefix = String(artifactName || "").trim();
  const sha = assertSha(sourceSha, "sourceSha");
  const active = artifacts.filter((artifact) => !artifact.expired);
  const excludedNames = new Set([
    `${prefix}-release-candidate-${sha}`,
    `${prefix}-summary-${sha}`,
    `${prefix}-diagnostics-summary-${sha}`,
  ]);
  const effectivePatterns = splitPatterns(patterns).length
    ? splitPatterns(patterns)
    : [`${prefix}-manifest-*-${sha}`];
  const matchers = effectivePatterns.map(artifactPatternToRegExp);
  return active
    .filter((artifact) => !excludedNames.has(String(artifact.name || "")))
    .filter((artifact) =>
      matchers.some((matcher) => matcher.test(String(artifact.name || ""))),
    )
    .sort((left, right) =>
      String(left.name || "").localeCompare(String(right.name || "")),
    );
}

export function findDownloadedFiles(root, filename) {
  const matches = [];
  const stack = fs.existsSync(root) ? [root] : [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name === filename) {
        matches.push(fullPath);
      }
    }
  }
  return matches.sort();
}

export function findDownloadedFilesByExtension(root, extensions = []) {
  const normalizedExtensions = extensions.map((extension) =>
    String(extension || "").toLowerCase(),
  );
  const matches = [];
  const stack = fs.existsSync(root) ? [root] : [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const lowerName = entry.name.toLowerCase();
      if (
        normalizedExtensions.some((extension) => lowerName.endsWith(extension))
      ) {
        matches.push(fullPath);
      }
    }
  }
  return matches.sort();
}

export function selectReleaseAssetPaths({ payloadRoot, patterns = [] } = {}) {
  const matchers = splitPatterns(patterns).map(artifactPatternToRegExp);
  if (matchers.length === 0) return [];
  const files = [];
  const stack = fs.existsSync(payloadRoot) ? [payloadRoot] : [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile() &&
        matchers.some((matcher) => matcher.test(entry.name))
      ) {
        files.push(fullPath);
      }
    }
  }
  files.sort();
  if (files.length === 0) {
    throw new Error(
      `release candidate payload patterns matched no files: ${splitPatterns(patterns).join(", ")}`,
    );
  }
  const selectedByBasename = new Map();
  const digest = (filePath) => digestFileSync(filePath, "sha256", "hex");
  for (const filePath of files) {
    const basename = path.basename(filePath);
    const existing = selectedByBasename.get(basename);
    if (!existing) selectedByBasename.set(basename, filePath);
    else if (digest(existing) !== digest(filePath))
      throw new Error(
        `release candidate public asset basename is not unique: ${basename}`,
      );
  }
  // Repeated paths are safe only when they name the same immutable bytes.
  return [...selectedByBasename.values()];
}

export function packageNameFromArtifactPath(filePath) {
  const basename = path.basename(String(filePath || ""));
  return basename
    .replace(/\.tgz$/i, "")
    .replace(/\.tar\.gz$/i, "")
    .replace(/\.zip$/i, "");
}

export function npmIntegrity(filePath) {
  return `sha512-${digestFileSync(filePath, "sha512", "base64")}`;
}

export function readNpmPackageJsonFromTarball(tarballPath) {
  const candidates = ["package/package.json", "./package/package.json"];
  const errors = [];
  for (const candidate of candidates) {
    try {
      return JSON.parse(
        execFileSync("tar", ["-xOf", path.basename(tarballPath), candidate], {
          cwd: path.dirname(tarballPath),
          encoding: "utf8",
        }),
      );
    } catch (error) {
      errors.push(error.stderr?.toString?.().trim() || error.message);
    }
  }
  throw new Error(
    `npm package tarball ${tarballPath} does not contain package/package.json: ${errors.filter(Boolean).join("; ")}`,
  );
}

export function readNpmPackageArtifact({
  tarballPath,
  mainPackage = "",
  kind = "npm",
} = {}) {
  const packageJson = readNpmPackageJsonFromTarball(tarballPath);
  const name = String(packageJson.name || "").trim();
  const version = String(packageJson.version || "").trim();
  if (!name || !version) {
    throw new Error(
      `npm package tarball ${tarballPath || "<empty>"} package.json must include name and version`,
    );
  }
  const integrity = npmIntegrity(tarballPath);
  return {
    kind,
    name,
    ref: version,
    digest: integrity,
    integrity,
    role: mainPackage && name === mainPackage ? "main" : "platform",
  };
}

export function generatePublishRequiredArtifacts({
  manifests = [],
  version = "",
  kind = "npm",
  tarballPaths = [],
  mainPackage = "",
} = {}) {
  if (String(kind || "") === "npm" && tarballPaths.length > 0) {
    const artifacts = tarballPaths
      .map((tarballPath) =>
        readNpmPackageArtifact({ tarballPath, mainPackage, kind }),
      )
      .sort((left, right) =>
        `${left.role}:${left.name}`.localeCompare(
          `${right.role}:${right.name}`,
        ),
      );
    const seen = new Set();
    for (const artifact of artifacts) {
      const key = `${artifact.name}@${artifact.ref}`;
      if (seen.has(key)) {
        throw new Error(`duplicate npm package tarball for ${key}`);
      }
      seen.add(key);
    }
    return artifacts;
  }
  const ref = String(version || "").trim();
  if (!ref) {
    return [];
  }
  return manifests.flatMap((manifest) => {
    const platform = manifest.platform?.id || manifest.platformId || "";
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    return files
      .filter((file) => file?.sha256)
      .map((file) => ({
        kind,
        name: packageNameFromArtifactPath(
          file.path || file.name || manifest.artifactName || platform,
        ),
        ref,
        digest: String(file.sha256).startsWith("sha256:")
          ? String(file.sha256)
          : `sha256:${file.sha256}`,
        role: "platform",
        platform,
      }));
  });
}

export function findDownloadedFile(root, filename) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name === filename) {
        return fullPath;
      }
    }
  }
  return "";
}

export function resolvePublicationEvidence(passportDir, passport, outputPath) {
  const stageCapsulesPath = findDownloadedFile(
    passportDir,
    "release-candidate-stage-capsules.json",
  );
  const publicationQualificationPath = findDownloadedFile(
    passportDir,
    "release-candidate-publication-qualification.json",
  );
  if (!passport.consumerPolicy?.receiptRoot) {
    return {
      paths: {
        stageCapsules: stageCapsulesPath ? outputPath(stageCapsulesPath) : "",
        publicationQualification: publicationQualificationPath
          ? outputPath(publicationQualificationPath)
          : "",
      },
      publicationQualificationRoot: "",
    };
  }
  if (!stageCapsulesPath || !publicationQualificationPath) {
    throw new Error(
      "v4 release candidate is missing Stage Capsules or publication qualification receipt",
    );
  }
  const stageCapsules = JSON.parse(fs.readFileSync(stageCapsulesPath, "utf8"));
  const qualification = JSON.parse(
    fs.readFileSync(publicationQualificationPath, "utf8"),
  );
  validatePublicationQualificationReceipt(qualification, {
    repository: passport.repository,
    candidateRoot: `sha256:${passport.candidateHash}`,
    sourceSha: passport.source.headSha,
    sourceRoot: domainContentRoot("candidate-identity", passport.source),
    artifactRoot: domainPublicationQualificationRoot(
      stageCapsules.capsules.map(
        ({ publicationArtifact }) => publicationArtifact,
      ),
    ),
    policyDigest: passport.consumerPolicy.receiptRoot,
  });
  if (stageCapsules.publicationQualificationRoot !== qualification.receiptRoot)
    throw new Error(
      "Stage Capsules do not bind the publication qualification receipt",
    );
  if (
    stageCapsules.capsules.some(
      ({ capsule }) =>
        capsule.identity.qualificationRoot !== qualification.receiptRoot,
    )
  )
    throw new Error(
      "a Stage Capsule does not bind the publication qualification receipt",
    );
  return {
    paths: {
      stageCapsules: outputPath(stageCapsulesPath),
      publicationQualification: outputPath(publicationQualificationPath),
    },
    publicationQualificationRoot: qualification.receiptRoot,
  };
}
