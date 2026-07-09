import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadBuildchainConfig } from "./buildchain-config.js";

export const PUBLICATION_NPM_PACKAGE_CONTRACT = "kungfu-buildchain-publication-npm-package";

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function copyFilePreservingPath({ cwd, outputDir, relPath, copied }) {
  const source = path.resolve(cwd, relPath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    return undefined;
  }
  const normalized = toPosix(relPath);
  if (copied.has(normalized)) {
    return copied.get(normalized);
  }
  const target = path.join(outputDir, normalized);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  const fact = {
    path: normalized,
    bytes: fs.statSync(target).size,
    sha256: sha256File(target),
  };
  copied.set(normalized, fact);
  return fact;
}

function publicationConfig(cwd) {
  const loaded = loadBuildchainConfig(cwd);
  if (loaded.config.project?.type !== "publication-artifact") {
    throw new Error('publication npm package requires project.type = "publication-artifact"');
  }
  if (!loaded.config.publication) {
    throw new Error("publication npm package requires [publication]");
  }
  const publish = loaded.config.publish || {};
  if (publish.kind && publish.kind !== "npm-paper-package") {
    throw new Error('publication npm package requires publish.kind = "npm-paper-package"');
  }
  return { loaded, publication: loaded.config.publication, publish };
}

export function collectPublicationPackageFacts({
  cwd = process.cwd(),
  packageName = "",
  outputDir = ".buildchain/publication/npm-package",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const { loaded, publication, publish } = publicationConfig(resolvedCwd);
  const name = packageName || publish.package || publish.mainPackage || "";
  if (!name) {
    throw new Error("publication npm package requires publish.package or --package-name");
  }
  const version = publication.version || "";
  if (!version) {
    throw new Error("publication npm package requires publication.version");
  }
  return {
    schemaVersion: 1,
    contract: PUBLICATION_NPM_PACKAGE_CONTRACT,
    package: {
      name,
      version,
      distTag: publish.distTag || (version.includes("-") ? "alpha" : "latest"),
      auth: publish.auth || "trusted-publishing",
    },
    project: {
      name: loaded.config.project?.name || path.basename(resolvedCwd),
      type: loaded.config.project?.type || "",
    },
    publication: {
      kind: publication.kind,
      title: publication.title,
      version,
      primaryArtifact: publication.primaryArtifact,
      manifestPath: publication.manifestPath,
      passportPath: ".buildchain/publication/publication-artifact-passport.json",
      registryPath: publication.archive?.registryPath || "",
      sourceBundlePath: publication.sourceBundlePath,
      artifactPaths: [publication.primaryArtifact, ...publication.artifactPaths].filter(Boolean),
      metadataPaths: publication.metadataPaths,
      siteConsumers: publication.siteConsumers,
    },
    outputDir: toPosix(outputDir),
  };
}

export function preparePublicationNpmPackage({
  cwd = process.cwd(),
  outputDir = ".buildchain/publication/npm-package",
  packageName = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const facts = collectPublicationPackageFacts({ cwd: resolvedCwd, outputDir, packageName });
  const resolvedOutputDir = path.resolve(resolvedCwd, outputDir);
  fs.rmSync(resolvedOutputDir, { recursive: true, force: true });
  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const copied = new Map();
  const declaredPaths = [
    facts.publication.manifestPath,
    facts.publication.passportPath,
    facts.publication.registryPath,
    facts.publication.sourceBundlePath,
    ...facts.publication.artifactPaths,
    ...facts.publication.metadataPaths,
  ].filter(Boolean);
  const files = declaredPaths
    .map((relPath) => copyFilePreservingPath({
      cwd: resolvedCwd,
      outputDir: resolvedOutputDir,
      relPath,
      copied,
    }))
    .filter(Boolean);

  const manifestFile = path.resolve(resolvedCwd, facts.publication.manifestPath);
  const passportFile = path.resolve(resolvedCwd, facts.publication.passportPath);
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`publication manifest is missing: ${facts.publication.manifestPath}`);
  }
  if (!fs.existsSync(passportFile)) {
    throw new Error(`publication passport is missing: ${facts.publication.passportPath}`);
  }
  if (!files.some((file) => file.path === facts.publication.primaryArtifact)) {
    throw new Error(`publication primary artifact is missing from npm package: ${facts.publication.primaryArtifact}`);
  }

  const sourcePackage = fs.existsSync(path.join(resolvedCwd, "package.json"))
    ? readJson(path.join(resolvedCwd, "package.json"))
    : {};
  const packageJson = {
    name: facts.package.name,
    version: facts.package.version,
    private: false,
    description: `${facts.publication.title} publication artifact package.`,
    license: sourcePackage.license || "UNLICENSED",
    type: "module",
    files: [
      ".buildchain/publication/",
      "buildchain-publication-package.json",
      facts.publication.primaryArtifact,
      ...facts.publication.artifactPaths,
      ...facts.publication.metadataPaths,
    ].filter(Boolean),
    exports: {
      "./package.json": "./package.json",
      "./publication-artifact.json": `./${facts.publication.manifestPath}`,
      "./publication-artifact-passport.json": `./${facts.publication.passportPath}`,
      ...(facts.publication.registryPath
        ? { "./publication-registry.json": `./${facts.publication.registryPath}` }
        : {}),
    },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
    },
    buildchain: {
      contract: PUBLICATION_NPM_PACKAGE_CONTRACT,
      publicationManifest: facts.publication.manifestPath,
      publicationPassport: facts.publication.passportPath,
      publicationRegistry: facts.publication.registryPath || undefined,
      primaryArtifact: facts.publication.primaryArtifact,
      sourceBundle: facts.publication.sourceBundlePath,
      siteConsumers: facts.publication.siteConsumers,
    },
  };
  fs.writeFileSync(path.join(resolvedOutputDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const readme = [
    `# ${facts.publication.title}`,
    "",
    "This npm package was synthesized by Buildchain from a publication-artifact repository.",
    "",
    `- Publication manifest: \`${facts.publication.manifestPath}\``,
    `- Publication passport: \`${facts.publication.passportPath}\``,
    `- Primary artifact: \`${facts.publication.primaryArtifact}\``,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(resolvedOutputDir, "README.md"), readme);

  const packageManifest = {
    ...facts,
    outputDir: toPosix(path.relative(resolvedCwd, resolvedOutputDir)),
    files: [
      {
        path: "package.json",
        bytes: fs.statSync(path.join(resolvedOutputDir, "package.json")).size,
        sha256: sha256File(path.join(resolvedOutputDir, "package.json")),
      },
      {
        path: "README.md",
        bytes: fs.statSync(path.join(resolvedOutputDir, "README.md")).size,
        sha256: sha256File(path.join(resolvedOutputDir, "README.md")),
      },
      ...files,
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
  fs.writeFileSync(
    path.join(resolvedOutputDir, "buildchain-publication-package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
  );
  return packageManifest;
}
