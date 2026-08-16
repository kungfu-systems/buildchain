import {
  adopterDeliveryGateDigest,
  createAdopterDeliveryGate,
  createGitCommitArtifactProfile,
  createPackageArtifactProfile,
  defineAdopterProtocolDriver,
  ADOPTER_PROTOCOL_DRIVER_INTERFACE,
} from "./adopter-delivery-gate.js";
import { qualifyBuildchainDeliveryInfrastructureBootstrap } from "./buildchain-delivery-bootstrap.js";
import { createKfdAdopterCategoryProtocolDriver } from "./kfd-adopter-category-driver.js";
import { createLegacyKfdAdopterProtocolDriver } from "./legacy-kfd-adopter-driver.js";
import { loadPublishedBuildchainDeliveryAuthority } from "./published-delivery-authority.js";

export const V4_ADOPTER_DELIVERY_CONTRACT =
  "kungfu-buildchain-v4-adopter-delivery/v1";
export const V4_ADOPTER_DELIVERY_READBACK_CONTRACT =
  "kungfu-buildchain-v4-adopter-delivery-readback/v1";
export const V4_ADOPTER_DELIVERY_BOOTSTRAP_LINEAGE_CONTRACT =
  "kungfu-buildchain-v4-adopter-delivery-bootstrap-lineage/v1";
export const V4_ADOPTER_DELIVERY_SOURCE = Object.freeze({
  branch: "dev/v3/v3.0",
  commit: "6b96bdad8d9f8ccf9275f27d9370a226a9c78465",
  vectorSuiteRoot:
    "sha256:c978707556406ffda4ef4192032332c01c2da1cebb6ad8c4f0edfc65d5cef0c7",
  kfdPackage: "@kungfu-tech/kfd@1.0.0-alpha.65",
  targetBranch: "dev/v4/v4.0",
  initialTargetBase: "e5611377efc03178f8687d99968cfdfa3ce2825b",
  targetBase: "e0342713c7447960c13bd73377282b2e93f4853d",
});
export const V4_ADOPTER_DELIVERY_ARCHIVE_AUTHORITY = Object.freeze({
  buildchain: Object.freeze({
    name: "@kungfu-tech/buildchain",
    version: "3.0.9-alpha.16",
    archiveRoot:
      "sha256:3f425e2c77d11f0bee8eb9aa2448566bca7a9d14672a7e528ced3e505b3f14a3",
    artifactRoot:
      "sha256:3f425e2c77d11f0bee8eb9aa2448566bca7a9d14672a7e528ced3e505b3f14a3",
  }),
  kfd: Object.freeze({
    name: "@kungfu-tech/kfd",
    version: "1.0.0-alpha.65",
    archiveRoot:
      "sha256:c4dbd3f954910236d7f0823ea6887f4151e43b871df526ccdd599123421bced2",
    artifactRoot:
      "sha256:c0781bcaf191a58561ae32ee2fbedabbb48ed50b5725c356fbd83704089637f8",
  }),
  authorityRoot:
    "sha256:9ba0cc6042b189ce749d01003617b57bcd03ea6ecf40e96d19e8ecbbfa347134",
});

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const BUILTIN_DRIVER_SELECTORS = Object.freeze({
  "json-assertion": "buildchain.adopter/json-assertion@1.0.0",
  "kfd-category": "kfd.adopter-category/instance-manifest@1.0.0",
  "legacy-kfd": "buildchain.kfd-adopter/legacy-support-matrix@1.0.0",
});
const BUILTIN_PROFILE_SELECTORS = Object.freeze({
  "git-commit": "buildchain.artifact/git-commit@1.0.0",
  package: "buildchain.artifact/package@1.0.0",
});

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new TypeError(`${label} has an unsupported field set`);
  }
  return structuredClone(value);
}

function definitionKey(value) {
  return `${value.id}@${value.version}`;
}

function resolveSelector(selector, table, definitions, label) {
  const expected = table[selector];
  if (!expected) throw new RangeError(`unknown ${label} selector: ${selector}`);
  const selected = definitions.find(
    (entry) => definitionKey(entry) === expected,
  );
  if (!selected)
    throw new Error(
      `${label} selector is not backed by an exact implementation`,
    );
  return selected;
}

export function createJsonAssertionAdopterProtocolDriver() {
  return defineAdopterProtocolDriver({
    interface: ADOPTER_PROTOCOL_DRIVER_INTERFACE,
    id: "buildchain.adopter/json-assertion",
    version: "1.0.0",
    verify({ request }) {
      const declaration = request.declaration;
      const exact =
        declaration &&
        typeof declaration === "object" &&
        !Array.isArray(declaration) &&
        Object.keys(declaration).length === 1 &&
        typeof declaration.valid === "boolean";
      const valid = exact && declaration.valid === true;
      const issues = valid
        ? []
        : [
            {
              code: "delivery-json-assertion-rejected",
              path: "/declaration",
              message:
                "JSON assertion declarations must contain only valid: true.",
            },
          ];
      const report = {
        schemaVersion: 1,
        contract: "kungfu-buildchain-json-assertion-driver-report/v1",
        valid,
        declaration: structuredClone(declaration),
        qualifying: false,
        selfCertified: false,
        releaseAuthorized: false,
      };
      return {
        valid,
        report,
        reportRoot: adopterDeliveryGateDigest(report),
        issues,
      };
    },
  });
}

export function createV4AdopterDeliveryRuntime({
  drivers = [],
  artifactProfiles = [],
} = {}) {
  const allDrivers = [
    createJsonAssertionAdopterProtocolDriver(),
    createKfdAdopterCategoryProtocolDriver(),
    createLegacyKfdAdopterProtocolDriver(),
    ...drivers,
  ];
  const allProfiles = [
    createGitCommitArtifactProfile(),
    createPackageArtifactProfile(),
    ...artifactProfiles,
  ];
  return Object.freeze({
    drivers: Object.freeze(allDrivers),
    artifactProfiles: Object.freeze(allProfiles),
    evaluate({
      request,
      context = {},
      driverSelector,
      artifactProfileSelector,
    } = {}) {
      const driver = resolveSelector(
        driverSelector,
        BUILTIN_DRIVER_SELECTORS,
        allDrivers,
        "driver",
      );
      const profile = resolveSelector(
        artifactProfileSelector,
        BUILTIN_PROFILE_SELECTORS,
        allProfiles,
        "artifact profile",
      );
      if (definitionKey(driver) !== definitionKey(request?.protocol ?? {})) {
        throw new Error(
          "driver selector does not match the exact request protocol",
        );
      }
      if (
        definitionKey(profile) !== definitionKey(request?.artifactProfile ?? {})
      ) {
        throw new Error(
          "artifact profile selector does not match the exact request profile",
        );
      }
      return createAdopterDeliveryGate({
        drivers: [driver],
        artifactProfiles: [profile],
      }).evaluate(structuredClone(request), structuredClone(context));
    },
  });
}

export function runV4AdopterDeliveryGate(input, options = {}) {
  const normalized = exactKeys(
    input,
    [
      "schemaVersion",
      "contract",
      "driverSelector",
      "artifactProfileSelector",
      "request",
      "context",
    ],
    "v4 adopter delivery input",
  );
  if (
    normalized.schemaVersion !== 1 ||
    normalized.contract !== V4_ADOPTER_DELIVERY_CONTRACT
  ) {
    throw new Error("v4 adopter delivery contract or version is unsupported");
  }
  const gateResult =
    createV4AdopterDeliveryRuntime(options).evaluate(normalized);
  const result = {
    schemaVersion: 1,
    contract: V4_ADOPTER_DELIVERY_READBACK_CONTRACT,
    sourceAuthority: structuredClone(V4_ADOPTER_DELIVERY_SOURCE),
    selection: {
      driver: normalized.driverSelector,
      artifactProfile: normalized.artifactProfileSelector,
    },
    gateResult,
    qualifying: false,
    selfCertified: false,
    releaseAuthorized: false,
    finalAuthority: "selected-public-driver-plus-exact-consumer-readback",
  };
  result.deliveryRoot = adopterDeliveryGateDigest(result);
  return result;
}

export function verifyV4AdopterDeliveryReadback(
  { input, readback } = {},
  options = {},
) {
  if (!readback || !ROOT.test(readback.deliveryRoot ?? "")) {
    throw new Error("exact adopter delivery readback is required");
  }
  const observed = runV4AdopterDeliveryGate(input, options);
  if (
    observed.deliveryRoot !== readback.deliveryRoot ||
    adopterDeliveryGateDigest(observed) !== adopterDeliveryGateDigest(readback)
  ) {
    throw new Error(
      "adopter delivery readback does not match exact recomputation",
    );
  }
  return observed;
}

export function qualifyV4AdopterDeliveryBootstrap({ input, lineage } = {}) {
  const normalizedLineage = exactKeys(
    lineage,
    [
      "schemaVersion",
      "contract",
      "sourceAuthorityCommit",
      "targetBaseCommit",
      "authorityArchiveRoot",
    ],
    "bootstrap lineage",
  );
  if (
    normalizedLineage.schemaVersion !== 1 ||
    normalizedLineage.contract !==
      V4_ADOPTER_DELIVERY_BOOTSTRAP_LINEAGE_CONTRACT ||
    normalizedLineage.sourceAuthorityCommit !==
      V4_ADOPTER_DELIVERY_SOURCE.commit ||
    normalizedLineage.targetBaseCommit !==
      V4_ADOPTER_DELIVERY_SOURCE.targetBase ||
    !SHA.test(normalizedLineage.sourceAuthorityCommit) ||
    !SHA.test(normalizedLineage.targetBaseCommit) ||
    !ROOT.test(normalizedLineage.authorityArchiveRoot ?? "") ||
    normalizedLineage.authorityArchiveRoot !== input?.authority?.packageRoot
  ) {
    throw new Error(
      "bootstrap lineage does not bind the exact v3 authority and v4 base",
    );
  }
  const bootstrap = qualifyBuildchainDeliveryInfrastructureBootstrap(input);
  const result = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-adopter-delivery-bootstrap/v1",
    sourceAuthority: structuredClone(V4_ADOPTER_DELIVERY_SOURCE),
    lineage: normalizedLineage,
    bootstrap,
    qualifying: false,
    selfCertified: false,
    releaseAuthorized: false,
  };
  result.resultRoot = adopterDeliveryGateDigest(result);
  return result;
}

export async function loadV4PublishedAdopterDeliveryAuthority({
  packages,
  expectedAuthorityRoot,
} = {}) {
  const request = assertV4PublishedAdopterDeliveryRequest({
    packages,
    expectedAuthorityRoot,
  });
  const authority = await loadPublishedBuildchainDeliveryAuthority(
    request.packages,
  );
  if (authority.authorityRoot !== expectedAuthorityRoot) {
    await authority.dispose();
    throw new Error("published archive authority readback root does not match");
  }
  return authority;
}

export function assertV4PublishedAdopterDeliveryRequest({
  packages,
  expectedAuthorityRoot,
} = {}) {
  if (
    !ROOT.test(expectedAuthorityRoot ?? "") ||
    expectedAuthorityRoot !==
      V4_ADOPTER_DELIVERY_ARCHIVE_AUTHORITY.authorityRoot
  ) {
    throw new Error(
      "exact published archive authority readback root is required",
    );
  }
  const normalizedPackages = exactKeys(
    packages,
    ["buildchain", "kfd"],
    "published archive packages",
  );
  for (const key of ["buildchain", "kfd"]) {
    const declaration = exactKeys(
      normalizedPackages[key],
      ["name", "version", "archivePath", "archiveRoot", "artifactRoot"],
      `${key} archive identity`,
    );
    const expected = V4_ADOPTER_DELIVERY_ARCHIVE_AUTHORITY[key];
    if (
      typeof declaration.archivePath !== "string" ||
      declaration.archivePath.length === 0 ||
      declaration.name !== expected.name ||
      declaration.version !== expected.version ||
      declaration.archiveRoot !== expected.archiveRoot ||
      declaration.artifactRoot !== expected.artifactRoot
    ) {
      throw new Error(`${key} archive identity is not the exact v3 authority`);
    }
  }
  return {
    packages: normalizedPackages,
    expectedAuthorityRoot,
  };
}

export const V4_ADOPTER_DELIVERY_SELECTORS = Object.freeze({
  drivers: BUILTIN_DRIVER_SELECTORS,
  artifactProfiles: BUILTIN_PROFILE_SELECTORS,
});
