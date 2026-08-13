import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { loadBuildchainConfig } from "./buildchain-config.js";
import { writePublicationArtifact } from "./publication-artifact.js";
import { preparePublicationNpmPackage } from "./publication-package.js";
import { spawnSyncCommand } from "./spawn-command.js";

export const PUBLICATION_REPRODUCIBILITY_RECEIPT_CONTRACT =
  "kungfu-buildchain-publication-reproducibility-receipt";

const DEFAULT_OUTPUT = ".buildchain/publication/reproducibility-receipt.json";
const DEFAULT_REGISTRY_INPUT_DIR = ".buildchain/publication/registry-inputs";
const DEFAULT_REGISTRY_HYDRATION =
  ".buildchain/publication/registry-hydration.json";
const DEFAULT_PACKAGE_DIR = ".buildchain/publication/npm-package";
const DEFAULT_PACKAGE_TARBALL_DIR = ".buildchain/publication/npm-tarball";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

function toPosix(value) {
  return String(value || "")
    .split(path.sep)
    .join("/");
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function digestValue(value) {
  return `sha256:${sha256Buffer(Buffer.from(stableJson(value)))}`;
}

function run(
  command,
  args,
  { cwd, env = process.env, label = [command, ...args].join(" ") } = {},
) {
  const result = spawnSyncCommand(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${label} failed with exit ${result.status}${detail ? `\n${detail}` : ""}`,
    );
  }
  return String(result.stdout || "").trim();
}

function git(cwd, args, fallback) {
  try {
    return run("git", args, { cwd, label: `git ${args.join(" ")}` });
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

function assertSafeRelativePath(relPath, label) {
  const normalized = path.posix
    .normalize(toPosix(relPath))
    .replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  return normalized;
}

function fileFact(root, relPath) {
  const normalized = assertSafeRelativePath(relPath, "artifact path");
  const filePath = path.resolve(root, normalized);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`reproducibility output is missing: ${normalized}`);
  }
  return {
    path: normalized,
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
  };
}

function pdfMetadataFact(filePath) {
  const text = fs.readFileSync(filePath).toString("latin1");
  const values = (pattern) =>
    [...text.matchAll(pattern)].map((match) => match[1]);
  const ids = [...text.matchAll(/\/ID\s*\[\s*<([^>]*)>\s*<([^>]*)>\s*\]/g)].map(
    (match) => [match[1], match[2]],
  );
  const metadata = {
    creationDates: values(/\/CreationDate\s*\(([^)]*)\)/g),
    modificationDates: values(/\/ModDate\s*\(([^)]*)\)/g),
    documentIds: ids,
  };
  return {
    ...metadata,
    metadataRoot: digestValue(metadata),
  };
}

function publicationArtifactFact(root, relPath) {
  const fact = fileFact(root, relPath);
  if (!fact.path.toLowerCase().endsWith(".pdf")) {
    return fact;
  }
  return {
    ...fact,
    pdfMetadata: pdfMetadataFact(path.resolve(root, fact.path)),
  };
}

function tarText(buffer, start, length) {
  return buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "")
    .trim();
}

function tarOctal(buffer, start, length) {
  const value = tarText(buffer, start, length).replace(/\s/g, "");
  return value ? Number.parseInt(value, 8) : 0;
}

function inspectSourceArchive(filePath, sourceDateEpoch) {
  const tar = zlib.gunzipSync(fs.readFileSync(filePath));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const size = tarOctal(header, 124, 12);
    const entry = {
      path: toPosix(prefix ? `${prefix}/${name}` : name),
      mode: tarOctal(header, 100, 8),
      uid: tarOctal(header, 108, 8),
      gid: tarOctal(header, 116, 8),
      size,
      mtime: tarOctal(header, 136, 12),
      type: tarText(header, 156, 1) || "0",
    };
    entries.push(entry);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const archiveHeaders = entries.filter(
    (entry) => entry.type === "g" || entry.path === "pax_global_header",
  );
  const contentEntries = entries.filter(
    (entry) => entry.type !== "g" && entry.path !== "pax_global_header",
  );
  const paths = contentEntries.map((entry) => entry.path);
  const expectedPaths = [...paths].sort();
  const mtimes = [...new Set(entries.map((entry) => entry.mtime))];
  const uids = [...new Set(entries.map((entry) => entry.uid))];
  const gids = [...new Set(entries.map((entry) => entry.gid))];
  const orderingNormalized =
    JSON.stringify(paths) === JSON.stringify(expectedPaths);
  const orderingDifferenceIndex = orderingNormalized
    ? -1
    : paths.findIndex((entry, index) => entry !== expectedPaths[index]);
  const timestampsNormalized =
    mtimes.length === 1 && String(mtimes[0]) === String(sourceDateEpoch);
  const ownersNormalized =
    uids.length === 1 && uids[0] === 0 && gids.length === 1 && gids[0] === 0;
  const normalized =
    entries.length > 0 &&
    archiveHeaders.every(
      (entry, index) => index === 0 && entry.path === "pax_global_header",
    ) &&
    orderingNormalized &&
    timestampsNormalized &&
    ownersNormalized;
  return {
    normalized,
    orderingNormalized,
    orderingDifference:
      orderingDifferenceIndex === -1
        ? null
        : {
            index: orderingDifferenceIndex,
            actual: paths[orderingDifferenceIndex],
            expected: expectedPaths[orderingDifferenceIndex],
          },
    timestampsNormalized,
    ownersNormalized,
    ordering: "optional-pax-header-then-lexicographic",
    mtimePolicy: "source-date-epoch",
    ownerPolicy: "root-zero",
    entryCount: entries.length,
    entries,
    metadataRoot: digestValue(entries),
  };
}

function listFileFacts(root, relPath) {
  const normalized = assertSafeRelativePath(relPath, "directory path");
  const target = path.resolve(root, normalized);
  if (!fs.existsSync(target)) {
    return [];
  }
  if (fs.statSync(target).isFile()) {
    return [fileFact(root, normalized)];
  }
  return fs
    .readdirSync(target, { withFileTypes: true })
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    .flatMap((entry) => {
      const child = path.posix.join(normalized, entry.name);
      return entry.isDirectory()
        ? listFileFacts(root, child)
        : entry.isFile()
          ? [fileFact(root, child)]
          : [];
    });
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyRelative(sourceRoot, targetRoot, relPath) {
  const normalized = assertSafeRelativePath(relPath, "overlay path");
  const source = path.resolve(sourceRoot, normalized);
  if (!fs.existsSync(source)) {
    return false;
  }
  const target = path.resolve(targetRoot, normalized);
  ensureParent(target);
  fs.cpSync(source, target, {
    recursive: fs.statSync(source).isDirectory(),
    force: true,
  });
  return true;
}

function sourceFacts(cwd, requestedSha = "") {
  const canonicalCwd = fs.realpathSync(cwd);
  const repositoryRoot = fs.realpathSync(
    git(canonicalCwd, ["rev-parse", "--show-toplevel"]),
  );
  const projectPath = toPosix(git(canonicalCwd, ["rev-parse", "--show-prefix"]))
    .replace(/\/+$/u, "") || ".";
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const sha = git(repositoryRoot, [
    "rev-parse",
    `${requestedSha || head}^{commit}`,
  ]);
  if (sha !== head) {
    throw new Error(
      `reproducibility source must be the checked-out HEAD: requested ${sha}, HEAD is ${head}`,
    );
  }
  const trackedStatus = git(repositoryRoot, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (trackedStatus) {
    throw new Error(
      "reproducibility source has tracked working-tree changes; commit the exact admitted source before building",
    );
  }
  const sourceDateEpoch = git(repositoryRoot, [
    "show",
    "-s",
    "--format=%ct",
    sha,
  ]);
  if (!/^\d+$/.test(sourceDateEpoch)) {
    throw new Error(
      "reproducibility source commit has no valid commit timestamp",
    );
  }
  return {
    repository:
      git(repositoryRoot, ["config", "--get", "remote.origin.url"], "") ||
      "local-git-source",
    repositoryRoot,
    projectPath,
    sha,
    treeSha: git(repositoryRoot, ["rev-parse", `${sha}^{tree}`]),
    sourceDateEpoch,
  };
}

function toolchainFacts(config) {
  const publication = config.publication || {};
  const declared = publication.toolchain || {};
  const type = String(
    process.env.BUILDCHAIN_PUBLICATION_TOOLCHAIN_TYPE ||
      declared.type ||
      "custom-command",
  ).trim();
  const facts = {
    type,
    image: String(
      process.env.BUILDCHAIN_PUBLICATION_TOOLCHAIN_IMAGE ||
        declared.image ||
        "",
    ).trim(),
    digest: String(
      process.env.BUILDCHAIN_PUBLICATION_TOOLCHAIN_DIGEST ||
        declared.digest ||
        "",
    ).trim(),
    command: String(
      process.env.BUILDCHAIN_PUBLICATION_TOOLCHAIN_COMMAND ||
        declared.command ||
        "",
    ).trim(),
  };
  if (!["latex-docker", "custom-command"].includes(facts.type)) {
    throw new Error(
      `unsupported publication reproducibility toolchain: ${facts.type}`,
    );
  }
  if (!facts.command) {
    throw new Error("publication reproducibility requires a toolchain command");
  }
  if (facts.type === "latex-docker") {
    if (!facts.image) {
      throw new Error(
        "latex-docker publication reproducibility requires a toolchain image",
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(facts.digest)) {
      throw new Error(
        "latex-docker publication reproducibility requires an exact sha256 image digest",
      );
    }
  }
  const machineVerifiable =
    facts.type === "latex-docker" &&
    Boolean(facts.image && facts.digest && facts.command);
  return {
    ...facts,
    imageRef:
      facts.type === "latex-docker" ? `${facts.image}@${facts.digest}` : "",
    machineVerifiable,
    identityRoot: digestValue({
      type: facts.type,
      image: facts.image,
      digest: facts.digest,
      command: facts.command,
    }),
  };
}

function cloneSource({ cwd, cloneRoot, source, overlayPaths }) {
  run(
    "git",
    [
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--no-checkout",
      source.repositoryRoot,
      cloneRoot,
    ],
    {
      cwd: path.dirname(cloneRoot),
      label: "independent local git clone",
    },
  );
  git(cloneRoot, ["checkout", "--quiet", "--detach", source.sha]);
  if (source.repository !== "local-git-source") {
    git(cloneRoot, ["remote", "set-url", "origin", source.repository]);
  }
  const projectRoot =
    source.projectPath === "."
      ? cloneRoot
      : path.resolve(cloneRoot, source.projectPath);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(
      `publication project path is missing from the source commit: ${source.projectPath}`,
    );
  }
  for (const relPath of overlayPaths) {
    copyRelative(cwd, projectRoot, relPath);
  }
  return projectRoot;
}

function isolatedEnvironment(buildRoot, source, toolchain) {
  const home = path.join(
    buildRoot,
    ".buildchain",
    "reproducibility-runtime",
    "home",
  );
  const cache = path.join(
    buildRoot,
    ".buildchain",
    "reproducibility-runtime",
    "npm-cache",
  );
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    npm_config_cache: cache,
    npm_config_ignore_scripts: "true",
    SOURCE_DATE_EPOCH: source.sourceDateEpoch,
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    BUILDCHAIN_PUBLICATION_TOOLCHAIN_TYPE: toolchain.type,
    BUILDCHAIN_PUBLICATION_TOOLCHAIN_IMAGE: toolchain.image,
    BUILDCHAIN_PUBLICATION_TOOLCHAIN_DIGEST: toolchain.digest,
    BUILDCHAIN_PUBLICATION_TOOLCHAIN_COMMAND: toolchain.command,
  };
}

function executeToolchain({ buildRoot, source, toolchain }) {
  const env = isolatedEnvironment(buildRoot, source, toolchain);
  if (toolchain.type === "latex-docker") {
    const dockerArgs = [
      "run",
      "--rm",
      "--network=none",
      "--env",
      `SOURCE_DATE_EPOCH=${source.sourceDateEpoch}`,
      "--env",
      "TZ=UTC",
      "--env",
      "LANG=C.UTF-8",
      "--env",
      "LC_ALL=C.UTF-8",
      "--env",
      "HOME=/tmp",
      "--volume",
      `${buildRoot}:/workspace`,
      "--workdir",
      "/workspace",
      toolchain.imageRef,
      "bash",
      "-lc",
      toolchain.command,
    ];
    run("docker", dockerArgs, {
      cwd: buildRoot,
      env,
      label: `pinned publication toolchain ${toolchain.imageRef}`,
    });
    return;
  }
  run("bash", ["-lc", toolchain.command], {
    cwd: buildRoot,
    env,
    label: "custom publication toolchain command",
  });
}

function registryInputs(buildRoot) {
  const inputDir = path.resolve(buildRoot, DEFAULT_REGISTRY_INPUT_DIR);
  if (!fs.existsSync(inputDir)) {
    return [];
  }
  return fs
    .readdirSync(inputDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(inputDir, entry));
}

function withPublicationEnvironment(source, toolchain, callback) {
  const updates = {
    SOURCE_DATE_EPOCH: source.sourceDateEpoch,
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    BUILDCHAIN_PUBLICATION_TOOLCHAIN_TYPE: toolchain.type,
    BUILDCHAIN_PUBLICATION_TOOLCHAIN_IMAGE: toolchain.image,
    BUILDCHAIN_PUBLICATION_TOOLCHAIN_DIGEST: toolchain.digest,
    BUILDCHAIN_PUBLICATION_TOOLCHAIN_COMMAND: toolchain.command,
  };
  const previous = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, updates);
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function packPublication({ buildRoot, packageDir, source, toolchain }) {
  const packDir = path.join(
    buildRoot,
    ".buildchain",
    "reproducibility-runtime",
    "pack",
  );
  fs.mkdirSync(packDir, { recursive: true });
  const output = run(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDir,
      `--registry=${DEFAULT_REGISTRY}`,
    ],
    {
      cwd: packageDir,
      env: isolatedEnvironment(buildRoot, source, toolchain),
      label: "npm pack reproducibility candidate",
    },
  );
  const parsed = JSON.parse(output);
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!result?.filename || !result?.integrity || !result?.shasum) {
    throw new Error(
      "npm pack reproducibility candidate did not report filename, integrity, and shasum",
    );
  }
  const tarballPath = path.resolve(packDir, result.filename);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(
      `npm pack reproducibility candidate is missing: ${result.filename}`,
    );
  }
  return {
    name: result.name,
    version: result.version,
    filename: result.filename,
    integrity: result.integrity,
    shasum: result.shasum,
    bytes: fs.statSync(tarballPath).size,
    sha256: sha256File(tarballPath),
    tarballPath,
  };
}

function comparableEntry(kind, fact) {
  return {
    key: `${kind}:${fact.path}`,
    kind,
    path: fact.path,
    bytes: fact.bytes,
    sha256: fact.sha256,
  };
}

function buildOnce({
  buildId,
  cloneRoot,
  cwd,
  source,
  toolchain,
  overlayPaths,
  packageName,
}) {
  const buildRoot = cloneSource({
    cwd,
    cloneRoot,
    source,
    overlayPaths,
  });
  executeToolchain({ buildRoot, source, toolchain });
  const generatedAt = new Date(
    Number(source.sourceDateEpoch) * 1000,
  ).toISOString();
  const publication = withPublicationEnvironment(source, toolchain, () =>
    writePublicationArtifact({
      cwd: buildRoot,
      sourceSha: source.sha,
      generatedAt,
      registryInputs: registryInputs(buildRoot),
    }),
  );
  const packageManifest = preparePublicationNpmPackage({
    cwd: buildRoot,
    outputDir: DEFAULT_PACKAGE_DIR,
    packageName,
  });
  const packageDir = path.resolve(buildRoot, packageManifest.outputDir);
  const npmPackage = packPublication({
    buildRoot,
    packageDir,
    source,
    toolchain,
  });
  const artifactFacts = publication.manifest.artifacts.map((entry) =>
    publicationArtifactFact(buildRoot, entry.path),
  );
  const publicationFacts = [
    fileFact(buildRoot, publication.manifestPath),
    fileFact(buildRoot, publication.passportPath),
    ...(publication.registryPath
      ? [fileFact(buildRoot, publication.registryPath)]
      : []),
  ];
  const sourceBundle = publication.manifest.source.sourceBundle
    ? fileFact(buildRoot, publication.manifest.source.sourceBundle.path)
    : undefined;
  const sourceBundleArchive = sourceBundle
    ? inspectSourceArchive(
        path.resolve(buildRoot, sourceBundle.path),
        source.sourceDateEpoch,
      )
    : undefined;
  if (sourceBundleArchive && !sourceBundleArchive.normalized) {
    throw new Error(
      `source bundle archive metadata is not normalized: ordering=${sourceBundleArchive.orderingNormalized}, timestamps=${sourceBundleArchive.timestampsNormalized}, owners=${sourceBundleArchive.ownersNormalized}, orderingDifference=${JSON.stringify(sourceBundleArchive.orderingDifference)}`,
    );
  }
  const packageFiles = listFileFacts(buildRoot, packageManifest.outputDir);
  const comparable = [
    ...artifactFacts.map((fact) => comparableEntry("artifact", fact)),
    ...(sourceBundle ? [comparableEntry("source-bundle", sourceBundle)] : []),
    ...publicationFacts.map((fact) =>
      comparableEntry("publication-evidence", fact),
    ),
    ...packageFiles.map((fact) =>
      comparableEntry("npm-package-file", {
        ...fact,
        path: toPosix(path.relative(packageManifest.outputDir, fact.path)),
      }),
    ),
    {
      key: `npm-tarball:${npmPackage.filename}`,
      kind: "npm-tarball",
      path: npmPackage.filename,
      bytes: npmPackage.bytes,
      sha256: npmPackage.sha256,
      integrity: npmPackage.integrity,
      shasum: npmPackage.shasum,
    },
  ];
  return {
    buildId,
    workspace: {
      class: "independent-local-git-clone",
      cache: "isolated-per-build",
      network:
        toolchain.type === "latex-docker"
          ? "disabled-during-build"
          : "caller-command-boundary",
    },
    artifacts: artifactFacts,
    sourceBundle,
    sourceBundleArchive,
    publication: {
      manifestPath: publication.manifestPath,
      passportPath: publication.passportPath,
      registryPath: publication.registryPath || "",
    },
    publicationEvidence: publicationFacts,
    npmPackage: {
      name: npmPackage.name,
      version: npmPackage.version,
      filename: npmPackage.filename,
      integrity: npmPackage.integrity,
      shasum: npmPackage.shasum,
      bytes: npmPackage.bytes,
      sha256: npmPackage.sha256,
    },
    packageFiles,
    comparable,
    outputSetRoot: digestValue(comparable),
    promotion: {
      artifactPaths: artifactFacts.map((entry) => entry.path),
      publicationPath: ".buildchain/publication",
      npmTarball: {
        sourcePath: toPosix(path.relative(buildRoot, npmPackage.tarballPath)),
        targetPath: path.posix.join(DEFAULT_PACKAGE_TARBALL_DIR, npmPackage.filename),
      },
    },
  };
}

function firstDifference(leftBuild, rightBuild) {
  const left = new Map(leftBuild.comparable.map((entry) => [entry.key, entry]));
  const right = new Map(
    rightBuild.comparable.map((entry) => [entry.key, entry]),
  );
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const key of keys) {
    const leftEntry = left.get(key);
    const rightEntry = right.get(key);
    if (!leftEntry || !rightEntry) {
      return {
        key,
        kind: leftEntry?.kind || rightEntry?.kind || "unknown",
        path: leftEntry?.path || rightEntry?.path || "",
        reason: leftEntry
          ? "missing-from-second-build"
          : "missing-from-first-build",
        firstBuild: leftEntry || null,
        secondBuild: rightEntry || null,
      };
    }
    for (const field of ["bytes", "sha256", "integrity", "shasum"]) {
      if ((leftEntry[field] || "") !== (rightEntry[field] || "")) {
        return {
          key,
          kind: leftEntry.kind,
          path: leftEntry.path,
          field,
          reason: "field-mismatch",
          firstBuild: leftEntry[field] ?? null,
          secondBuild: rightEntry[field] ?? null,
        };
      }
    }
  }
  return null;
}

function receipt({ source, toolchain, builds, difference, error }) {
  const { repositoryRoot: _repositoryRoot, ...receiptSource } = source;
  const comparisonPassed = builds.length === 2 && !difference && !error;
  const issues = [];
  if (error) {
    issues.push({
      code: "clean-build-failed",
      message: error.message,
    });
  }
  if (difference) {
    issues.push({
      code: "publication-bytes-differ",
      message: `first difference ${difference.key}${
        difference.field ? ` at ${difference.field}` : ""
      }`,
    });
  }
  if (!toolchain.machineVerifiable) {
    issues.push({
      code: "toolchain-not-machine-verifiable",
      message:
        "custom-command builds may diagnose byte drift but cannot qualify publication admission; use a digest-pinned latex-docker toolchain",
    });
  }
  const payload = {
    schemaVersion: 1,
    contract: PUBLICATION_REPRODUCIBILITY_RECEIPT_CONTRACT,
    status: comparisonPassed ? "passed" : "failed",
    qualifying: comparisonPassed && toolchain.machineVerifiable,
    source: receiptSource,
    toolchain,
    policy: {
      independentBuilds: 2,
      sourceCheckout: "independent-local-git-clone",
      sourceTimestamp: "git-commit-time",
      timezone: "UTC",
      locale: "C.UTF-8",
      npmCache: "isolated-per-build",
      npmScripts: "disabled",
      artifactComparison: "exact-bytes",
      admission: "fail-closed-before-alpha-or-release",
    },
    builds: builds.map(
      ({ comparable: _comparable, promotion: _promotion, ...entry }) => entry,
    ),
    comparison: {
      status: comparisonPassed ? "identical" : "different",
      firstDifference: difference || null,
    },
    issues,
  };
  return {
    ...payload,
    receiptDigest: digestValue(payload),
  };
}

function writeReceipt(cwd, output, value) {
  const normalized = assertSafeRelativePath(
    output || DEFAULT_OUTPUT,
    "reproducibility receipt output",
  );
  const target = path.resolve(cwd, normalized);
  ensureParent(target);
  fs.writeFileSync(target, stableJson(value));
  return normalized;
}

function promoteBuild(cwd, buildRoot, build) {
  for (const relPath of build.promotion.artifactPaths) {
    const source = path.resolve(buildRoot, relPath);
    const target = path.resolve(cwd, relPath);
    ensureParent(target);
    fs.copyFileSync(source, target);
  }
  const publicationPath = assertSafeRelativePath(
    build.promotion.publicationPath,
    "publication promotion path",
  );
  const sourcePublication = path.resolve(buildRoot, publicationPath);
  const targetPublication = path.resolve(cwd, publicationPath);
  fs.rmSync(targetPublication, { recursive: true, force: true });
  ensureParent(targetPublication);
  fs.cpSync(sourcePublication, targetPublication, {
    recursive: true,
    force: true,
  });
  const npmTarballSource = path.resolve(
    buildRoot,
    assertSafeRelativePath(build.promotion.npmTarball.sourcePath, "npm tarball promotion source"),
  );
  const npmTarballTarget = path.resolve(
    cwd,
    assertSafeRelativePath(build.promotion.npmTarball.targetPath, "npm tarball promotion target"),
  );
  ensureParent(npmTarballTarget);
  fs.copyFileSync(npmTarballSource, npmTarballTarget);
}

export function verifyPublicationReproducibility({
  cwd = process.cwd(),
  sourceSha = "",
  output = DEFAULT_OUTPUT,
  promote = false,
  keepWorkspaces = false,
  pullToolchain = true,
  packageName = "",
  allowUnpinnedToolchain = false,
  overlayPaths = [DEFAULT_REGISTRY_INPUT_DIR, DEFAULT_REGISTRY_HYDRATION],
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const loaded = loadBuildchainConfig(resolvedCwd);
  if (loaded.config.project?.type !== "publication-artifact") {
    throw new Error(
      'publication reproducibility requires project.type = "publication-artifact"',
    );
  }
  const source = sourceFacts(resolvedCwd, sourceSha);
  const toolchain = toolchainFacts(loaded.config);
  if (toolchain.type === "latex-docker" && pullToolchain) {
    run("docker", ["pull", toolchain.imageRef], {
      cwd: resolvedCwd,
      label: `pull pinned publication toolchain ${toolchain.imageRef}`,
    });
  }
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-publication-reproducibility-"),
  );
  const builds = [];
  let error;
  try {
    for (let index = 0; index < 2; index += 1) {
      const cloneRoot = path.join(tempRoot, `build-${index + 1}`);
      try {
        builds.push(
          buildOnce({
            buildId: `build-${index + 1}`,
            cloneRoot,
            cwd: resolvedCwd,
            source,
            toolchain,
            overlayPaths,
            packageName,
          }),
        );
      } catch (buildError) {
        error = buildError;
        break;
      }
    }
    const difference =
      builds.length === 2 ? firstDifference(builds[0], builds[1]) : null;
    const result = receipt({
      source,
      toolchain,
      builds,
      difference,
      error,
    });
    if (
      promote &&
      result.status === "passed" &&
      (result.qualifying || allowUnpinnedToolchain)
    ) {
      const firstProjectRoot =
        source.projectPath === "."
          ? path.join(tempRoot, "build-1")
          : path.join(tempRoot, "build-1", source.projectPath);
      promoteBuild(resolvedCwd, firstProjectRoot, builds[0]);
    }
    result.outputPath = writeReceipt(resolvedCwd, output, result);
    return result;
  } finally {
    if (!keepWorkspaces) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
