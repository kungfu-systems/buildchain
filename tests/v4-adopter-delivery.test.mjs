import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { normalizeBuildchainConfig } from "../packages/core/buildchain-config.js";
import { loadPublishedBuildchainDeliveryAuthority } from "../packages/core/published-delivery-authority.js";
import {
  V4_ADOPTER_DELIVERY_ARCHIVE_AUTHORITY,
  V4_ADOPTER_DELIVERY_SOURCE,
  assertV4PublishedAdopterDeliveryRequest,
  loadV4PublishedAdopterDeliveryAuthority,
  qualifyV4AdopterDeliveryBootstrap,
  runV4AdopterDeliveryGate,
  verifyV4AdopterDeliveryReadback,
} from "../packages/core/v4-adopter-delivery.js";

const root = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(root, "contracts/fixtures/v4-adopter-delivery-v1");
const positive = JSON.parse(
  fs.readFileSync(path.join(fixtures, "gate-positive.json"), "utf8"),
);
const bootstrap = JSON.parse(
  fs.readFileSync(path.join(fixtures, "bootstrap-positive.json"), "utf8"),
);

function packageConfig(overrides = {}) {
  return {
    schema: 1,
    adopter_delivery: {
      contract: "kungfu-buildchain-v4-adopter-delivery/v1",
      input_path: "contracts/input.json",
      readback_path: ".buildchain/adopter-delivery/readback.json",
      bootstrap_path: "contracts/bootstrap.json",
      archive_path: "contracts/archive.json",
      result_path: ".buildchain/adopter-delivery/result.json",
      driver_selector: "json-assertion",
      artifact_profile_selector: "git-commit",
      ...overrides,
    },
  };
}

async function archiveFixture(
  rootPath,
  { name, version, modules = {}, artifactRoot = "" },
) {
  const packageRoot = path.join(rootPath, name.replaceAll("/", "-"), "package");
  await mkdir(path.join(packageRoot, "packages/core"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version, type: "module" })}\n`,
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
      `${JSON.stringify({ kfdCut: { package: { name, version, artifactRoot } } })}\n`,
    );
  }
  const fixtureDirectory = name.replaceAll("/", "-");
  const archiveName = `${fixtureDirectory}.tgz`;
  const archivePath = path.join(rootPath, archiveName);
  execFileSync(
    "tar",
    ["-czf", archiveName, "-C", fixtureDirectory, "package"],
    { cwd: rootPath },
  );
  const archiveRoot = `sha256:${createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex")}`;
  return {
    name,
    version,
    archivePath,
    archiveRoot,
    artifactRoot: artifactRoot || archiveRoot,
  };
}

async function authorityPackages(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), "v4-adopter-delivery-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const modules = {
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
    "kfd-adopter-category-driver.js": [
      "createKfdAdopterCategoryProtocolDriver",
    ],
  };
  return {
    buildchain: await archiveFixture(temporary, {
      name: "@kungfu-tech/buildchain",
      version: "3.0.9-alpha.16",
      modules,
    }),
    kfd: await archiveFixture(temporary, {
      name: "@kungfu-tech/kfd",
      version: "1.0.0-alpha.65",
      artifactRoot: `sha256:${"a".repeat(64)}`,
    }),
  };
}

test("public schema, config and source authority bind the exact v3 and v4 cuts", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(root, "contracts/v4-adopter-delivery-v1.schema.json"),
    ),
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(positive), true, JSON.stringify(validate.errors));
  assert.deepEqual(V4_ADOPTER_DELIVERY_SOURCE, {
    branch: "dev/v3/v3.0",
    commit: "6b96bdad8d9f8ccf9275f27d9370a226a9c78465",
    vectorSuiteRoot:
      "sha256:c978707556406ffda4ef4192032332c01c2da1cebb6ad8c4f0edfc65d5cef0c7",
    kfdPackage: "@kungfu-tech/kfd@1.0.0-alpha.65",
    targetBranch: "dev/v4/v4.0",
    initialTargetBase: "e5611377efc03178f8687d99968cfdfa3ce2825b",
    targetBase: "e0342713c7447960c13bd73377282b2e93f4853d",
  });
  const normalized = normalizeBuildchainConfig(packageConfig());
  assert.equal(normalized.adopter_delivery.driverSelector, "json-assertion");
  assert.throws(
    () =>
      normalizeBuildchainConfig(packageConfig({ driver_selector: "private" })),
    /selector is unsupported/,
  );
  assert.throws(
    () => normalizeBuildchainConfig(packageConfig({ input_path: "../escape" })),
    /repository-relative/,
  );
});

test("public driver run and exact readback are deterministic and fail closed", () => {
  const readback = runV4AdopterDeliveryGate(positive);
  assert.equal(readback.gateResult.status, "passed");
  assert.equal(readback.releaseAuthorized, false);
  assert.deepEqual(
    verifyV4AdopterDeliveryReadback({ input: positive, readback }),
    readback,
  );

  const tampered = structuredClone(readback);
  tampered.gateResult.artifact.root = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () =>
      verifyV4AdopterDeliveryReadback({ input: positive, readback: tampered }),
    /does not match exact recomputation/,
  );
  const unknown = JSON.parse(
    fs.readFileSync(path.join(fixtures, "gate-unknown-selector.json"), "utf8"),
  );
  assert.throws(
    () => runV4AdopterDeliveryGate(unknown),
    /unknown driver selector/,
  );
  const version = structuredClone(positive);
  version.request.protocol.version = "2.0.0";
  assert.throws(
    () => runV4AdopterDeliveryGate(version),
    /does not match the exact request protocol/,
  );
  assert.throws(
    () => verifyV4AdopterDeliveryReadback({ input: positive }),
    /readback is required/,
  );
});

test("exact N-1 bootstrap lineage passes and substitutions fail closed", () => {
  const result = qualifyV4AdopterDeliveryBootstrap(bootstrap);
  assert.equal(
    result.bootstrap.status,
    "passed",
    JSON.stringify(result.bootstrap.issues),
  );
  assert.equal(result.releaseAuthorized, false);
  for (const mutate of [
    (value) => {
      value.lineage.sourceAuthorityCommit = "f".repeat(40);
    },
    (value) => {
      value.lineage.targetBaseCommit = "f".repeat(40);
    },
    (value) => {
      value.lineage.authorityArchiveRoot = `sha256:${"f".repeat(64)}`;
    },
  ]) {
    const changed = structuredClone(bootstrap);
    mutate(changed);
    assert.throws(
      () => qualifyV4AdopterDeliveryBootstrap(changed),
      /bootstrap lineage does not bind/,
    );
  }
});

test("published archives load from exact bytes and v4 rejects non-authority identities", async (t) => {
  const packages = await authorityPackages(t);
  const observed = await loadPublishedBuildchainDeliveryAuthority(packages);
  const expectedAuthorityRoot = observed.authorityRoot;
  await observed.dispose();

  const officialRequest = JSON.parse(
    fs.readFileSync(path.join(fixtures, "archive-template.json"), "utf8"),
  );
  assert.deepEqual(
    assertV4PublishedAdopterDeliveryRequest(officialRequest),
    officialRequest,
  );
  assert.deepEqual(V4_ADOPTER_DELIVERY_ARCHIVE_AUTHORITY, {
    buildchain: {
      name: "@kungfu-tech/buildchain",
      version: "3.0.9-alpha.16",
      archiveRoot:
        "sha256:3f425e2c77d11f0bee8eb9aa2448566bca7a9d14672a7e528ced3e505b3f14a3",
      artifactRoot:
        "sha256:3f425e2c77d11f0bee8eb9aa2448566bca7a9d14672a7e528ced3e505b3f14a3",
    },
    kfd: {
      name: "@kungfu-tech/kfd",
      version: "1.0.0-alpha.65",
      archiveRoot:
        "sha256:c4dbd3f954910236d7f0823ea6887f4151e43b871df526ccdd599123421bced2",
      artifactRoot:
        "sha256:c0781bcaf191a58561ae32ee2fbedabbb48ed50b5725c356fbd83704089637f8",
    },
    authorityRoot:
      "sha256:9ba0cc6042b189ce749d01003617b57bcd03ea6ecf40e96d19e8ecbbfa347134",
  });

  await assert.rejects(
    loadV4PublishedAdopterDeliveryAuthority({
      packages,
      expectedAuthorityRoot:
        V4_ADOPTER_DELIVERY_ARCHIVE_AUTHORITY.authorityRoot,
    }),
    /archive identity is not the exact v3 authority/,
  );
  await assert.rejects(
    loadV4PublishedAdopterDeliveryAuthority({
      packages: officialRequest.packages,
      expectedAuthorityRoot: `sha256:${"f".repeat(64)}`,
    }),
    /exact published archive authority readback root is required/,
  );

  const authority = await loadPublishedBuildchainDeliveryAuthority(packages);
  assert.equal(authority.packages.buildchain.version, "3.0.9-alpha.16");
  await authority.dispose();

  await assert.rejects(
    loadPublishedBuildchainDeliveryAuthority({
      ...packages,
      buildchain: { ...packages.buildchain, version: "3.0.9-alpha.15" },
    }),
    /extracted package identity does not match/,
  );
});

test("CLI and public self-dogfood workflow expose the same public boundary", () => {
  const completed = spawnSync(
    process.execPath,
    [
      "bin/buildchain.mjs",
      "adopter-delivery",
      "run",
      "--input",
      path.join(fixtures, "gate-positive.json"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).gateResult.status, "passed");

  const caller = fs.readFileSync(
    path.join(root, ".github/workflows/self-build-adopter-dogfood.yml"),
    "utf8",
  );
  assert.match(
    caller,
    /kungfu-systems\/buildchain\/\.github\/workflows\/v4-adopter-delivery\.yml@v4-alpha/,
  );
  assert.doesNotMatch(caller, /(?:uses:\s*\.\/|runs-on:|steps:|BUILDCHAIN_)/);
});

test("candidate dispatch binds an external adopter to one exact source cut", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/v4-adopter-delivery.yml"),
    "utf8",
  );
  assert.equal(
    (workflow.match(/^      consumer-repository:$/gmu) || []).length,
    2,
  );
  assert.equal((workflow.match(/^      consumer-ref:$/gmu) || []).length, 2);
  assert.equal(
    (workflow.match(/^      invocation-source-path:$/gmu) || []).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /repository: \$\{\{ inputs\['consumer-repository'\] \|\| github\.repository \}\}/gu,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /ref: \$\{\{ inputs\['consumer-ref'\] \|\| github\.sha \}\}/gu,
      ) || []
    ).length,
    2,
  );
  assert.match(
    workflow,
    /consumer-source-sha: \$\{\{ steps\.consumer-source\.outputs\.sha \}\}/u,
  );
  assert.match(
    workflow,
    /EXPECTED_CONSUMER_SHA: \$\{\{ needs\.consumer-admission\.outputs\.consumer-source-sha \}\}/u,
  );
  assert.match(
    workflow,
    /--source-sha "\$\{\{ steps\.consumer-source\.outputs\.sha \}\}"/u,
  );
  assert.match(
    workflow,
    /--consumer-sha "\$\{\{ steps\.consumer-source\.outputs\.sha \}\}"/u,
  );
  assert.doesNotMatch(workflow, /--consumer-sha "\$\{\{ github\.sha \}\}"/u);
});
