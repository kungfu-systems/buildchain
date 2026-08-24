import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initAdopterManifest,
  verifyAdopterManifestFromPackage,
} from "@kungfu-tech/kfd/adopter-conformance/toolchain";

import {
  adopterDeliveryGateDigest,
  createAdopterDeliveryGate,
  createPackageArtifactProfile,
} from "../packages/core/adopter-delivery-gate.js";
import { qualifyBuildchainDeliveryInfrastructureBootstrap } from "../packages/core/buildchain-delivery-bootstrap.js";
import {
  BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID,
  BUILDCHAIN_DELIVERY_INFRASTRUCTURE_PROFILE,
  createBuildchainDeliveryInfrastructureInstanceManifest,
  verifyBuildchainDeliveryInfrastructureInstance,
} from "../packages/core/buildchain-delivery-infrastructure.js";
import {
  BUILDCHAIN_DELIVERY_SELF_DOGFOOD_CONTRACT,
  createBuildchainDeliveryInfrastructureSelfDogfood,
  createPublishedBuildchainDeliveryInfrastructureCandidateSelfDogfood,
  createPublishedBuildchainDeliveryInfrastructureSelfDogfood,
} from "../packages/core/buildchain-delivery-self-dogfood.js";
import {
  createKfdAdopterCategoryProtocolDriver,
  resolvePublishedKfdAdopterCategoryProfiles,
} from "../packages/core/kfd-adopter-category-driver.js";

const checkedAt = "2026-08-12T00:00:00.000Z";
const maxAgeSeconds = 86400;
const root = (value) => adopterDeliveryGateDigest(value);
const commit = (character) => character.repeat(40);
const kfdPackageRoot = root("kfd-1.0.0-alpha.65-package-bytes");
const authorityPackageRoot = root("buildchain-3.0.9-alpha.10-package-bytes");
const candidatePackageRoot = root("buildchain-3.0.9-alpha.11-package-bytes");
const source = {
  kind: "git-commit",
  coordinate: `${BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID}@${commit("b")}`,
  root: root("buildchain-alpha.11-source"),
};
const artifact = {
  kind: "package",
  coordinate: "@kungfu-tech/buildchain@3.0.9-alpha.11",
  root: candidatePackageRoot,
};
const release = {
  kind: "release",
  coordinate:
    "https://github.com/kungfu-systems/buildchain/releases/tag/v3.0.9-alpha.11",
  root: root("buildchain-alpha.11-release"),
};
const instanceId = "kungfu-systems/buildchain@3.0.9-alpha.11";
const gateContractRoot = root("adopter-delivery-gate-contract-v1");
const protocolRoot = root("kfd-adopter-category-driver-v1");
const profileRoot = root("delivery-infrastructure-profile-v1");

const authorityRuntime = {
  createBuildchainDeliveryInfrastructureInstanceManifest,
  verifyBuildchainDeliveryInfrastructureInstance,
  createAdopterDeliveryGate,
  createPackageArtifactProfile,
  createKfdAdopterCategoryProtocolDriver,
  qualifyBuildchainDeliveryInfrastructureBootstrap,
};

function cut({ version, sourceCommit, packageRoot, authorityVersion } = {}) {
  return {
    version,
    sourceCommit,
    packageRoot,
    gateRoot: gateContractRoot,
    protocol: {
      id: "kfd.adopter-category/instance-manifest",
      version: "1.0.0",
      root: protocolRoot,
    },
    profile: {
      id: BUILDCHAIN_DELIVERY_INFRASTRUCTURE_PROFILE.id,
      version: BUILDCHAIN_DELIVERY_INFRASTRUCTURE_PROFILE.version,
      root: profileRoot,
    },
    ...(authorityVersion ? { authorityVersion } : {}),
  };
}

function fixture() {
  const adopterManifest = initAdopterManifest({
    manifestId: "buildchain-v3-self-dogfood-candidate",
    adopterId: BUILDCHAIN_DELIVERY_INFRASTRUCTURE_ADOPTER_ID,
    artifactKind: artifact.kind,
    artifactCoordinate: artifact.coordinate,
    artifactRoot: artifact.root,
    scope: "Buildchain delivery infrastructure self-dogfood",
    packageArtifactRoot: kfdPackageRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds,
  });
  adopterManifest.releaseBindings.push({
    id: "buildchain-3.0.9-alpha.11",
    artifact: structuredClone(artifact),
    releasePassport: structuredClone(release),
    kfdPackageRoot,
  });
  const adopterReport = verifyAdopterManifestFromPackage(adopterManifest, {
    packageArtifactRoot: kfdPackageRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds,
  });
  assert.equal(adopterReport.valid, true, JSON.stringify(adopterReport.issues));

  const resolution = resolvePublishedKfdAdopterCategoryProfiles({
    schemaVersion: 1,
    contract: "kfd.adopter-category-profile-selection/v1",
    profiles: [structuredClone(BUILDCHAIN_DELIVERY_INFRASTRUCTURE_PROFILE)],
  });
  let rootIndex = 1;
  const evidence = resolution.requirements.flatMap((requirement) =>
    requirement.evidenceKinds.flatMap((kind) =>
      Array.from({ length: requirement.minimumEvidencePerKind }, () => ({
        requirementId: requirement.id,
        kind,
        coordinate: `evidence://buildchain/${requirement.id}/${kind}`,
        root: `sha256:${String(rootIndex++).padStart(64, "0")}`,
        observedAt: checkedAt,
      })),
    ),
  );
  const authority = {
    ...cut({
      version: "3.0.9-alpha.10",
      sourceCommit: commit("a"),
      packageRoot: authorityPackageRoot,
    }),
    protected: true,
    published: true,
  };
  const candidate = cut({
    version: "3.0.9-alpha.11",
    sourceCommit: commit("b"),
    packageRoot: candidatePackageRoot,
    authorityVersion: authority.version,
  });
  const warrant = {
    outcome: "merged",
    sourceHead: candidate.sourceCommit,
    sourceProofRoot: root("source-proof"),
    nativeProofRoot: root("native-proof"),
    integrationProofRoot: root("integration-proof"),
  };
  return {
    authorityPackage: {
      name: "@kungfu-tech/buildchain",
      version: authority.version,
      artifactRoot: authority.packageRoot,
    },
    kfdPackage: structuredClone(adopterManifest.kfdCut.package),
    authority,
    candidate,
    instanceId,
    adopterManifest,
    source,
    artifact,
    release,
    evidence,
    warrant,
    verifiedAt: checkedAt,
    maxAgeSeconds,
  };
}

test("published N-1 Buildchain and KFD abilities self-dogfood an exact candidate", () => {
  const result = createBuildchainDeliveryInfrastructureSelfDogfood(
    fixture(),
    authorityRuntime,
  );

  assert.equal(result.contract, BUILDCHAIN_DELIVERY_SELF_DOGFOOD_CONTRACT);
  assert.equal(result.status, "passed");
  assert.equal(
    result.authorityRuntime.buildchainPackage.version,
    "3.0.9-alpha.10",
  );
  assert.equal(result.authorityRuntime.kfdPackage.version, "1.0.0-alpha.65");
  assert.equal(result.instanceReport.valid, true);
  assert.equal(result.gateResult.status, "passed");
  assert.equal(result.bootstrap.status, "passed");
  assert.equal(result.roots.gateResult, result.gateResult.gateRoot);
  assert.equal(result.roots.bootstrap, result.bootstrap.bootstrapRoot);
  assert.equal(result.qualifying, false);
  assert.equal(result.selfCertified, false);
  assert.equal(result.releaseAuthorized, false);
  assert.match(result.selfDogfoodRoot, /^sha256:[0-9a-f]{64}$/);
});

test("package substitution and missing N-1 abilities fail closed", () => {
  const substituted = fixture();
  substituted.authorityPackage.artifactRoot = root("substituted-package");
  assert.throws(
    () =>
      createBuildchainDeliveryInfrastructureSelfDogfood(
        substituted,
        authorityRuntime,
      ),
    /package root does not match/,
  );

  const incompleteRuntime = { ...authorityRuntime };
  delete incompleteRuntime.createAdopterDeliveryGate;
  assert.throws(
    () =>
      createBuildchainDeliveryInfrastructureSelfDogfood(
        fixture(),
        incompleteRuntime,
      ),
    /authority runtime is missing createAdopterDeliveryGate/,
  );
});

test("missing candidate evidence cannot produce a self-dogfood result", () => {
  const input = fixture();
  input.evidence = input.evidence.filter(
    ({ requirementId }) => requirementId !== "protected-delivery",
  );

  assert.throws(
    () =>
      createBuildchainDeliveryInfrastructureSelfDogfood(
        input,
        authorityRuntime,
      ),
    /instance failed closed/,
  );
});

async function authorityArchive(
  rootDirectory,
  { name, version, modules = {}, semanticArtifactRoot = "" },
) {
  const source = path.join(rootDirectory, name.replaceAll("/", "-"));
  const packageRoot = path.join(source, "package");
  await mkdir(path.join(packageRoot, "packages/core"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version, type: "module" }, null, 2)}\n`,
  );
  for (const [file, body] of Object.entries(modules)) {
    await writeFile(path.join(packageRoot, "packages/core", file), body);
  }
  if (name === "@kungfu-tech/kfd") {
    const manifestRoot = path.join(
      packageRoot,
      "profiles/adopter-conformance/adopters/kfd",
    );
    await mkdir(manifestRoot, { recursive: true });
    await writeFile(
      path.join(manifestRoot, "manifest.json"),
      `${JSON.stringify(
        {
          kfdCut: {
            package: {
              name,
              version,
              artifactRoot: semanticArtifactRoot,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  const archivePath = path.join(
    rootDirectory,
    `${name.replaceAll("/", "-")}.tgz`,
  );
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

test("published archive bytes supply every self-dogfood semantic ability", async (t) => {
  const rootDirectory = await mkdtemp(
    path.join(tmpdir(), "published-self-dogfood-"),
  );
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const fixedRoot = `sha256:${"a".repeat(64)}`;
  const authorityPackages = {
    buildchain: await authorityArchive(rootDirectory, {
      name: "@kungfu-tech/buildchain",
      version: "3.0.9-alpha.10",
      modules: {
        "adopter-delivery-gate.js": `
          export const createAdopterDeliveryGate = () => ({ evaluate: (request) => ({
            schemaVersion: 1, contract: "synthetic-published-gate", status: "passed",
            project: request.project, artifact: request.artifact, gateRoot: ${JSON.stringify(fixedRoot)}
          }) });
          export const createPackageArtifactProfile = () => ({});
        `,
        "buildchain-delivery-bootstrap.js": `
          export const qualifyBuildchainDeliveryInfrastructureBootstrap = () => ({
            status: "passed", bootstrapRoot: ${JSON.stringify(fixedRoot)}
          });
        `,
        "buildchain-delivery-infrastructure.js": `
          export const createBuildchainDeliveryInfrastructureInstanceManifest = (value) => value;
          export const verifyBuildchainDeliveryInfrastructureInstance = () => ({ valid: true, issues: [] });
        `,
        "kfd-adopter-category-driver.js": `
          export const createKfdAdopterCategoryProtocolDriver = () => ({});
        `,
      },
    }),
    kfd: await authorityArchive(rootDirectory, {
      name: "@kungfu-tech/kfd",
      version: "1.0.0-alpha.65",
      semanticArtifactRoot: kfdPackageRoot,
    }),
  };
  const selfDogfood = fixture();
  selfDogfood.authority.packageRoot = authorityPackages.buildchain.artifactRoot;
  selfDogfood.adopterManifest.kfdCut.package.artifactRoot = kfdPackageRoot;

  const result =
    await createPublishedBuildchainDeliveryInfrastructureSelfDogfood({
      authorityPackages,
      selfDogfood,
    });

  assert.equal(result.status, "passed");
  assert.equal(
    result.authorityRuntime.buildchainPackage.artifactRoot,
    authorityPackages.buildchain.artifactRoot,
  );
  assert.match(result.publishedAuthorityRoot, /^sha256:[0-9a-f]{64}$/);

  const candidateResult =
    await createPublishedBuildchainDeliveryInfrastructureCandidateSelfDogfood({
      authorityPackages,
      authoritySourceCommit: commit("a"),
      candidatePackage: {
        name: "@kungfu-tech/buildchain",
        version: "3.0.9-alpha.11",
        artifactRoot: candidatePackageRoot,
      },
      warrantCandidate: {
        status: "merged",
        sourceHead: commit("b"),
        sourceProofRoot: root("candidate-source-proof"),
        terminal: {
          outcome: "merged",
          nativeProofRoot: root("candidate-native-proof"),
          evidenceRoot: root("candidate-integration-proof"),
        },
      },
      source,
      release,
      verifiedAt: checkedAt,
      maxAgeSeconds,
    });

  assert.equal(candidateResult.status, "passed");
  assert.equal(candidateResult.gateResult.status, "passed");
  assert.equal(candidateResult.candidate.sourceCommit, commit("b"));
  assert.equal(
    candidateResult.adopterManifest.kfdCut.package.artifactRoot,
    kfdPackageRoot,
  );
  assert.equal(candidateResult.releaseAuthorized, false);
});
