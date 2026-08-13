import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PUBLISHED_DELIVERY_AUTHORITY_CONTRACT,
  loadPublishedBuildchainDeliveryAuthority,
  withPublishedBuildchainDeliveryAuthority,
} from "../packages/core/published-delivery-authority.js";

const MODULES = {
  "adopter-delivery-gate.js": [
    "createAdopterDeliveryGate",
    "createPackageArtifactProfile",
  ],
  "buildchain-delivery-bootstrap.js": [
    "qualifyBuildchainDeliveryInfrastructureBootstrap",
  ],
  "buildchain-delivery-infrastructure.js": [
    "createBuildchainDeliveryInfrastructureInstanceManifest",
    "verifyBuildchainDeliveryInfrastructureInstance",
  ],
  "kfd-adopter-category-driver.js": ["createKfdAdopterCategoryProtocolDriver"],
};

async function archiveFixture(
  root,
  {
    name,
    version,
    modules = {},
    unsafeLink = false,
    semanticArtifactRoot = "",
  },
) {
  const source = path.join(root, `${name.replaceAll("/", "-")}-source`);
  const packageRoot = path.join(source, "package");
  await mkdir(path.join(packageRoot, "packages/core"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version, type: "module" }, null, 2)}\n`,
  );
  for (const [file, exports] of Object.entries(modules)) {
    await writeFile(
      path.join(packageRoot, "packages/core", file),
      `${exports.map((entry) => `export const ${entry} = () => ${JSON.stringify(entry)};`).join("\n")}\n`,
    );
  }
  if (name === "@kungfu-tech/kfd") {
    const manifestRoot = path.join(
      packageRoot,
      "profiles/adopter-conformance/adopters/kfd",
    );
    await mkdir(manifestRoot, { recursive: true });
    await writeFile(
      path.join(manifestRoot, "manifest.json"),
      `${JSON.stringify({
        kfdCut: {
          package: {
            name,
            version,
            artifactRoot: semanticArtifactRoot,
          },
        },
      }, null, 2)}\n`,
    );
  }
  if (unsafeLink) {
    await symlink("../outside", path.join(packageRoot, "unsafe-link"));
  }
  const archivePath = path.join(root, `${name.replaceAll("/", "-")}.tgz`);
  execFileSync("tar", ["-czf", archivePath, "-C", source, "package"]);
  const artifactRoot = `sha256:${createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex")}`;
  return {
    name,
    version,
    archivePath,
    archiveRoot: artifactRoot,
    artifactRoot: semanticArtifactRoot || artifactRoot,
  };
}

async function fixture(t, { buildchainModules = MODULES } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "published-authority-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    buildchain: await archiveFixture(root, {
      name: "@kungfu-tech/buildchain",
      version: "3.0.9-alpha.10",
      modules: buildchainModules,
    }),
    kfd: await archiveFixture(root, {
      name: "@kungfu-tech/kfd",
      version: "1.0.0-alpha.62",
      semanticArtifactRoot: `sha256:${"a".repeat(64)}`,
    }),
  };
}

test("exact public package bytes load only the declared N-1 abilities", async (t) => {
  const authority = await loadPublishedBuildchainDeliveryAuthority(
    await fixture(t),
  );
  t.after(() => authority.dispose());

  assert.equal(authority.contract, PUBLISHED_DELIVERY_AUTHORITY_CONTRACT);
  assert.equal(authority.packages.buildchain.version, "3.0.9-alpha.10");
  assert.equal(authority.packages.kfd.version, "1.0.0-alpha.62");
  assert.notEqual(
    authority.packages.kfd.archiveRoot,
    authority.packages.kfd.artifactRoot,
  );
  assert.deepEqual(Object.keys(authority.authorityRuntime).sort(), [
    "createAdopterDeliveryGate",
    "createBuildchainDeliveryInfrastructureInstanceManifest",
    "createKfdAdopterCategoryProtocolDriver",
    "createPackageArtifactProfile",
    "qualifyBuildchainDeliveryInfrastructureBootstrap",
    "verifyBuildchainDeliveryInfrastructureInstance",
  ]);
  assert.equal(authority.qualifying, false);
  assert.equal(authority.selfCertified, false);
  assert.equal(authority.releaseAuthorized, false);
  assert.match(authority.authorityRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(existsSync(authority.temporaryRoot), true);
});

test("archive-byte and extracted-identity substitution fail closed", async (t) => {
  const declarations = await fixture(t);
  await assert.rejects(
    loadPublishedBuildchainDeliveryAuthority({
      ...declarations,
      buildchain: {
        ...declarations.buildchain,
        archiveRoot: `sha256:${"f".repeat(64)}`,
        artifactRoot: `sha256:${"f".repeat(64)}`,
      },
    }),
    /archive bytes do not match/,
  );

  await assert.rejects(
    loadPublishedBuildchainDeliveryAuthority({
      ...declarations,
      kfd: { ...declarations.kfd, version: "1.0.0-alpha.61" },
    }),
    /extracted package identity does not match/,
  );

  await assert.rejects(
    loadPublishedBuildchainDeliveryAuthority({
      ...declarations,
      kfd: {
        ...declarations.kfd,
        artifactRoot: `sha256:${"e".repeat(64)}`,
      },
    }),
    /semantic package identity does not match/,
  );
});

test("unsafe entries and missing published abilities fail closed", async (t) => {
  const declarations = await fixture(t, {
    buildchainModules: {
      ...MODULES,
      "kfd-adopter-category-driver.js": [],
    },
  });
  await assert.rejects(
    loadPublishedBuildchainDeliveryAuthority(declarations),
    /missing createKfdAdopterCategoryProtocolDriver/,
  );

  declarations.buildchain = await archiveFixture(
    path.dirname(declarations.buildchain.archivePath),
    {
      name: "@kungfu-tech/buildchain",
      version: "3.0.9-alpha.10",
      modules: MODULES,
      unsafeLink: true,
    },
  );
  await assert.rejects(
    loadPublishedBuildchainDeliveryAuthority(declarations),
    /archive contains a non-file entry/,
  );
});

test("scoped authority use always cleans its temporary package root", async (t) => {
  const declarations = await fixture(t);
  let temporaryRoot = "";
  await assert.rejects(
    withPublishedBuildchainDeliveryAuthority(
      declarations,
      async (authority) => {
        temporaryRoot = authority.temporaryRoot;
        throw new Error("consumer failed");
      },
    ),
    /consumer failed/,
  );
  assert.equal(existsSync(temporaryRoot), false);
});
