import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";

import { adopterDeliveryGateDigest } from "./adopter-delivery-gate.js";

export const PUBLISHED_DELIVERY_AUTHORITY_CONTRACT =
  "kungfu-buildchain-published-delivery-authority/v1";

const execFileAsync = promisify(execFile);
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PACKAGES = [
  {
    key: "buildchain",
    name: "@kungfu-tech/buildchain",
    packageRoot: "archive",
    modules: {
      adopterDeliveryGate: "packages/core/adopter-delivery-gate.js",
      bootstrap: "packages/core/buildchain-delivery-bootstrap.js",
      infrastructure: "packages/core/buildchain-delivery-infrastructure.js",
      kfdCategoryDriver: "packages/core/kfd-adopter-category-driver.js",
    },
  },
  {
    key: "kfd",
    name: "@kungfu-tech/kfd",
    packageRoot: "profiles/adopter-conformance/adopters/kfd/manifest.json",
    modules: {},
  },
];

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function exactDeclaration(value, expectedName, label) {
  if (
    value?.name !== expectedName ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    typeof value.archivePath !== "string" ||
    value.archivePath.length === 0 ||
    !ROOT_PATTERN.test(value.archiveRoot ?? "") ||
    !ROOT_PATTERN.test(value.artifactRoot ?? "")
  ) {
    throw new TypeError(`${label} package declaration is incomplete`);
  }
  return structuredClone(value);
}

function safeArchiveEntries(listing, verboseListing, label) {
  const entries = listing.split("\n").filter(Boolean);
  const types = verboseListing.split("\n").filter(Boolean);
  if (entries.length === 0 || entries.length !== types.length) {
    throw new Error(`${label} archive listing is incomplete`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const parts = entry.split("/");
    if (
      parts[0] !== "package" ||
      parts.some((part, partIndex) =>
        partIndex === parts.length - 1 && part === ""
          ? false
          : part === "" || part === "." || part === "..",
      )
    ) {
      throw new Error(`${label} archive contains an unsafe path`);
    }
    if (!["-", "d"].includes(types[index][0])) {
      throw new Error(`${label} archive contains a non-file entry`);
    }
  }
}

async function extractPackage(declaration, destination, definition, label) {
  const observedRoot = await sha256File(declaration.archivePath);
  if (observedRoot !== declaration.archiveRoot) {
    throw new Error(`${label} archive bytes do not match archiveRoot`);
  }
  const [{ stdout: listing }, { stdout: verboseListing }] = await Promise.all([
    execFileAsync("tar", ["-tzf", declaration.archivePath], {
      maxBuffer: 16 * 1024 * 1024,
    }),
    execFileAsync("tar", ["-tvzf", declaration.archivePath], {
      maxBuffer: 16 * 1024 * 1024,
    }),
  ]);
  safeArchiveEntries(listing, verboseListing, label);
  await mkdir(destination, { recursive: true });
  await execFileAsync(
    "tar",
    [
      "-xzf",
      declaration.archivePath,
      "--strip-components",
      "1",
      "-C",
      destination,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const packageJsonPath = path.join(destination, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (
    packageJson.name !== declaration.name ||
    packageJson.version !== declaration.version
  ) {
    throw new Error(`${label} extracted package identity does not match`);
  }
  if (definition.packageRoot === "archive") {
    if (declaration.artifactRoot !== declaration.archiveRoot) {
      throw new Error(`${label} package artifactRoot must match archiveRoot`);
    }
  } else {
    const packageManifest = JSON.parse(
      await readFile(path.join(destination, definition.packageRoot), "utf8"),
    );
    const packageCut = packageManifest?.kfdCut?.package;
    if (
      packageCut?.name !== declaration.name ||
      packageCut?.version !== declaration.version ||
      packageCut?.artifactRoot !== declaration.artifactRoot
    ) {
      throw new Error(`${label} semantic package identity does not match`);
    }
  }
  const destinationRoot = await realpath(destination);
  if (!destinationRoot.endsWith(path.join(...declaration.name.split("/")))) {
    throw new Error(`${label} extraction escaped its package coordinate`);
  }
  return {
    name: declaration.name,
    version: declaration.version,
    archiveRoot: declaration.archiveRoot,
    artifactRoot: declaration.artifactRoot,
  };
}

async function importAuthorityRuntime(buildchainRoot) {
  const definition = PACKAGES[0];
  const imported = {};
  for (const [key, relativePath] of Object.entries(definition.modules)) {
    imported[key] = await import(
      pathToFileURL(path.join(buildchainRoot, relativePath)).href
    );
  }
  const runtime = {
    createAdopterDeliveryGate:
      imported.adopterDeliveryGate.createAdopterDeliveryGate,
    createPackageArtifactProfile:
      imported.adopterDeliveryGate.createPackageArtifactProfile,
    qualifyBuildchainDeliveryInfrastructureBootstrap:
      imported.bootstrap.qualifyBuildchainDeliveryInfrastructureBootstrap,
    createBuildchainDeliveryInfrastructureInstanceManifest:
      imported.infrastructure
        .createBuildchainDeliveryInfrastructureInstanceManifest,
    verifyBuildchainDeliveryInfrastructureInstance:
      imported.infrastructure.verifyBuildchainDeliveryInfrastructureInstance,
    createKfdAdopterCategoryProtocolDriver:
      imported.kfdCategoryDriver.createKfdAdopterCategoryProtocolDriver,
  };
  for (const [name, implementation] of Object.entries(runtime)) {
    if (typeof implementation !== "function") {
      throw new Error(`published Buildchain authority is missing ${name}`);
    }
  }
  return runtime;
}

export async function loadPublishedBuildchainDeliveryAuthority({
  buildchain,
  kfd,
} = {}) {
  const declarations = {
    buildchain: exactDeclaration(
      buildchain,
      "@kungfu-tech/buildchain",
      "Buildchain authority",
    ),
    kfd: exactDeclaration(kfd, "@kungfu-tech/kfd", "KFD authority"),
  };
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "buildchain-published-delivery-authority-"),
  );
  let retained = false;
  try {
    const identities = {};
    for (const definition of PACKAGES) {
      identities[definition.key] = await extractPackage(
        declarations[definition.key],
        path.join(temporaryRoot, "node_modules", ...definition.name.split("/")),
        definition,
        `${definition.key} authority`,
      );
    }
    const authorityRuntime = await importAuthorityRuntime(
      path.join(temporaryRoot, "node_modules", ...PACKAGES[0].name.split("/")),
    );
    const authority = {
      schemaVersion: 1,
      contract: PUBLISHED_DELIVERY_AUTHORITY_CONTRACT,
      packages: identities,
      moduleCoordinates: structuredClone(PACKAGES[0].modules),
      qualifying: false,
      selfCertified: false,
      releaseAuthorized: false,
      finalAuthority:
        "caller-bound-public-npm-archive-bytes-and-package-identity",
    };
    authority.authorityRoot = adopterDeliveryGateDigest(authority);
    retained = true;
    return {
      ...authority,
      authorityRuntime,
      temporaryRoot,
      async dispose() {
        await rm(temporaryRoot, { recursive: true, force: true });
      },
    };
  } finally {
    if (!retained) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function withPublishedBuildchainDeliveryAuthority(
  declarations,
  operation,
) {
  if (typeof operation !== "function") {
    throw new TypeError("published authority operation must be a function");
  }
  const authority =
    await loadPublishedBuildchainDeliveryAuthority(declarations);
  try {
    return await operation(authority);
  } finally {
    await authority.dispose();
  }
}
