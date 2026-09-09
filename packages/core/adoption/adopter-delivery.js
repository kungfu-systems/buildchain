import {
  adopterDeliveryGateDigest,
  createAdopterDeliveryGate,
  createGitCommitArtifactProfile,
  createPackageArtifactProfile,
  defineAdopterProtocolDriver,
  ADOPTER_PROTOCOL_DRIVER_INTERFACE,
} from "./adopter-delivery-gate.js";
import { createKfdAdopterCategoryProtocolDriver } from "./kfd-adopter-category-driver.js";

export const ADOPTER_DELIVERY_CONTRACT =
  "kungfu-buildchain-v4-adopter-delivery/v1";
export const ADOPTER_DELIVERY_READBACK_CONTRACT =
  "kungfu-buildchain-v4-adopter-delivery-readback/v1";
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const BUILTIN_DRIVER_SELECTORS = Object.freeze({
  "json-assertion": "buildchain.adopter/json-assertion@1.0.0",
  "kfd-category": "kfd.adopter-category/instance-manifest@1.0.0",
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

export function createAdopterDeliveryRuntime({
  drivers = [],
  artifactProfiles = [],
} = {}) {
  const allDrivers = [
    createJsonAssertionAdopterProtocolDriver(),
    createKfdAdopterCategoryProtocolDriver(),
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

export function runAdopterDeliveryGate(input, options = {}) {
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
    normalized.contract !== ADOPTER_DELIVERY_CONTRACT
  ) {
    throw new Error("v4 adopter delivery contract or version is unsupported");
  }
  const gateResult =
    createAdopterDeliveryRuntime(options).evaluate(normalized);
  const result = {
    schemaVersion: 1,
    contract: ADOPTER_DELIVERY_READBACK_CONTRACT,
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

export function verifyAdopterDeliveryReadback(
  { input, readback } = {},
  options = {},
) {
  if (!readback || !ROOT.test(readback.deliveryRoot ?? "")) {
    throw new Error("exact adopter delivery readback is required");
  }
  const observed = runAdopterDeliveryGate(input, options);
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
