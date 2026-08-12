import {
  adopterDeliveryGateDigest,
  isAdopterDeliveryJsonValue,
} from "./adopter-delivery-json.js";

export { adopterDeliveryGateDigest } from "./adopter-delivery-json.js";

export const ADOPTER_DELIVERY_GATE_REQUEST_CONTRACT =
  "kungfu-buildchain-adopter-delivery-request";
export const ADOPTER_DELIVERY_GATE_RESULT_CONTRACT =
  "kungfu-buildchain-adopter-delivery-result";
export const ADOPTER_PROTOCOL_DRIVER_INTERFACE =
  "kungfu-buildchain-adopter-protocol-driver/v1";
export const ADOPTER_ARTIFACT_PROFILE_INTERFACE =
  "kungfu-buildchain-adopter-artifact-profile/v1";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9.-]*)*$/;
const VERSION_PATTERN = /^[1-9][0-9]*\.[0-9]+\.[0-9]+$/;
const GIT_COMMIT_COORDINATE_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/;
const PACKAGE_COORDINATE_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function issue(code, path, message) {
  return { code, path, message };
}

function compareIssues(left, right) {
  return Buffer.compare(
    Buffer.from(`${left.code}\0${left.path}\0${left.message}`, "utf8"),
    Buffer.from(`${right.code}\0${right.path}\0${right.message}`, "utf8"),
  );
}

function exactObject(value, path, fields, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(
      issue("delivery-input-invalid", path, "Expected a JSON object."),
    );
    return false;
  }
  const admitted = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!admitted.has(key)) {
      issues.push(
        issue(
          "delivery-input-invalid",
          `${path}/${key}`,
          "Unknown fields fail closed.",
        ),
      );
    }
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) {
      issues.push(
        issue(
          "delivery-input-invalid",
          `${path}/${key}`,
          "Required field is missing.",
        ),
      );
    }
  }
  return true;
}

function exactReference(value, path, issues) {
  if (!exactObject(value, path, ["id", "version"], issues)) return;
  if (!ID_PATTERN.test(value.id ?? "")) {
    issues.push(
      issue("delivery-input-invalid", `${path}/id`, "Identifier is invalid."),
    );
  }
  if (!VERSION_PATTERN.test(value.version ?? "")) {
    issues.push(
      issue("delivery-input-invalid", `${path}/version`, "Version is invalid."),
    );
  }
}

function validateRequest(request) {
  const issues = [];
  if (
    !exactObject(
      request,
      "/",
      [
        "schemaVersion",
        "contract",
        "protocol",
        "artifactProfile",
        "project",
        "artifact",
        "declaration",
      ],
      issues,
    )
  )
    return issues;
  if (
    request.schemaVersion !== 1 ||
    request.contract !== ADOPTER_DELIVERY_GATE_REQUEST_CONTRACT
  ) {
    issues.push(
      issue(
        "delivery-input-invalid",
        "/contract",
        "Delivery request contract is unsupported.",
      ),
    );
  }
  exactReference(request.protocol, "/protocol", issues);
  exactReference(request.artifactProfile, "/artifactProfile", issues);
  if (
    exactObject(
      request.project,
      "/project",
      ["instanceId", "adopterId"],
      issues,
    )
  ) {
    for (const field of ["instanceId", "adopterId"]) {
      if (
        typeof request.project[field] !== "string" ||
        request.project[field].length === 0
      ) {
        issues.push(
          issue(
            "delivery-input-invalid",
            `/project/${field}`,
            "Expected a non-empty string.",
          ),
        );
      }
    }
  }
  if (
    exactObject(
      request.artifact,
      "/artifact",
      ["kind", "coordinate", "root"],
      issues,
    )
  ) {
    for (const field of ["kind", "coordinate"]) {
      if (
        typeof request.artifact[field] !== "string" ||
        request.artifact[field].length === 0
      ) {
        issues.push(
          issue(
            "delivery-input-invalid",
            `/artifact/${field}`,
            "Expected a non-empty string.",
          ),
        );
      }
    }
    if (!ROOT_PATTERN.test(request.artifact.root ?? "")) {
      issues.push(
        issue(
          "delivery-input-invalid",
          "/artifact/root",
          "Expected a canonical lowercase sha256 root.",
        ),
      );
    }
  }
  if (
    !request.declaration ||
    typeof request.declaration !== "object" ||
    Array.isArray(request.declaration) ||
    !isAdopterDeliveryJsonValue(request.declaration)
  ) {
    issues.push(
      issue(
        "delivery-input-invalid",
        "/declaration",
        "Expected a finite acyclic protocol-owned JSON object.",
      ),
    );
  }
  return issues;
}

function definitionReference(definition, interfaceContract, label) {
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  if (definition.interface !== interfaceContract) {
    throw new TypeError(`${label}.interface must be ${interfaceContract}`);
  }
  if (
    !ID_PATTERN.test(definition.id ?? "") ||
    !VERSION_PATTERN.test(definition.version ?? "")
  ) {
    throw new TypeError(`${label} identity or version is invalid`);
  }
  if (typeof definition.verify !== "function") {
    throw new TypeError(`${label}.verify must be a function`);
  }
}

function validIssue(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof entry.code === "string" &&
    entry.code.length > 0 &&
    typeof entry.path === "string" &&
    typeof entry.message === "string" &&
    entry.message.length > 0
  );
}

export function defineAdopterProtocolDriver(definition) {
  definitionReference(
    definition,
    ADOPTER_PROTOCOL_DRIVER_INTERFACE,
    "protocol driver",
  );
  return Object.freeze({
    interface: definition.interface,
    id: definition.id,
    version: definition.version,
    verify: definition.verify,
  });
}

export function defineAdopterArtifactProfile(definition) {
  definitionReference(
    definition,
    ADOPTER_ARTIFACT_PROFILE_INTERFACE,
    "artifact profile",
  );
  if (
    !Array.isArray(definition.kinds) ||
    definition.kinds.length === 0 ||
    definition.kinds.some(
      (kind) => typeof kind !== "string" || kind.length === 0,
    ) ||
    new Set(definition.kinds).size !== definition.kinds.length
  ) {
    throw new TypeError(
      "artifact profile kinds must be a non-empty unique string array",
    );
  }
  return Object.freeze({
    interface: definition.interface,
    id: definition.id,
    version: definition.version,
    kinds: Object.freeze([...definition.kinds]),
    verify: definition.verify,
  });
}

function coordinateProfile({ id, version, kind, pattern, message }) {
  return defineAdopterArtifactProfile({
    interface: ADOPTER_ARTIFACT_PROFILE_INTERFACE,
    id,
    version,
    kinds: [kind],
    verify(artifact) {
      const issues = [];
      if (!pattern.test(artifact.coordinate)) {
        issues.push(
          issue("delivery-artifact-invalid", "/artifact/coordinate", message),
        );
      }
      return { valid: issues.length === 0, issues };
    },
  });
}

export function createGitCommitArtifactProfile({
  id = "buildchain.artifact/git-commit",
  version = "1.0.0",
} = {}) {
  return coordinateProfile({
    id,
    version,
    kind: "git-commit",
    pattern: GIT_COMMIT_COORDINATE_PATTERN,
    message:
      "Git commit coordinates must bind one repository and exact lowercase 40-hex commit.",
  });
}

export function createPackageArtifactProfile({
  id = "buildchain.artifact/package",
  version = "1.0.0",
} = {}) {
  return coordinateProfile({
    id,
    version,
    kind: "package",
    pattern: PACKAGE_COORDINATE_PATTERN,
    message:
      "Package coordinates must bind one package name and immutable version.",
  });
}

function registry(definitions, label) {
  const result = new Map();
  for (const definition of definitions) {
    const key = `${definition.id}@${definition.version}`;
    if (result.has(key)) throw new TypeError(`${label} ${key} is duplicated`);
    result.set(key, definition);
  }
  return result;
}

function normalizeProfileResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.valid !== "boolean" ||
    !Array.isArray(result.issues) ||
    result.issues.some((entry) => !validIssue(entry))
  ) {
    return {
      valid: false,
      issues: [
        issue(
          "delivery-artifact-profile-result-invalid",
          "/artifactProfile",
          "Artifact profile returned an invalid result.",
        ),
      ],
    };
  }
  return {
    valid: result.valid,
    issues: result.issues.map(({ code, path, message }) => ({
      code,
      path,
      message,
    })),
  };
}

function normalizeDriverResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.valid !== "boolean" ||
    !ROOT_PATTERN.test(result.reportRoot ?? "") ||
    !Array.isArray(result.issues) ||
    result.issues.some((entry) => !validIssue(entry)) ||
    !Object.hasOwn(result, "report") ||
    !isAdopterDeliveryJsonValue(result.report)
  ) {
    return {
      valid: false,
      report: null,
      reportRoot: null,
      issues: [
        issue(
          "delivery-driver-result-invalid",
          "/protocol",
          "Protocol driver returned an invalid result.",
        ),
      ],
    };
  }
  return {
    valid: result.valid,
    report: structuredClone(result.report),
    reportRoot: result.reportRoot,
    issues: result.issues.map(({ code, path, message }) => ({
      code,
      path,
      message,
    })),
  };
}

function gateResult(
  request,
  protocolDriver,
  artifactProfile,
  profileResult,
  driverResult,
  issues,
) {
  const result = {
    schemaVersion: 1,
    contract: ADOPTER_DELIVERY_GATE_RESULT_CONTRACT,
    status: issues.length === 0 ? "passed" : "failed",
    qualifying: false,
    selfCertified: false,
    project: request?.project ? structuredClone(request.project) : null,
    artifact: request?.artifact ? structuredClone(request.artifact) : null,
    protocol: request?.protocol
      ? {
          ...structuredClone(request.protocol),
          loaded: Boolean(protocolDriver),
          reportRoot: driverResult?.reportRoot ?? null,
        }
      : null,
    artifactProfile: request?.artifactProfile
      ? {
          ...structuredClone(request.artifactProfile),
          loaded: Boolean(artifactProfile),
          valid: profileResult?.valid ?? false,
        }
      : null,
    semanticReport: driverResult?.report ?? null,
    nonClaims: [
      "A passing delivery gate does not grant runtime permission, release authorization, or independent certification.",
      "Protocol semantics remain owned by the selected protocol driver and its published authority.",
    ],
    issues: [...issues].sort(compareIssues),
  };
  result.gateRoot = adopterDeliveryGateDigest(result);
  return result;
}

export function createAdopterDeliveryGate({
  drivers = [],
  artifactProfiles = [],
} = {}) {
  if (!Array.isArray(drivers) || !Array.isArray(artifactProfiles)) {
    throw new TypeError("drivers and artifactProfiles must be arrays");
  }
  drivers.forEach((driver) =>
    definitionReference(
      driver,
      ADOPTER_PROTOCOL_DRIVER_INTERFACE,
      "protocol driver",
    ),
  );
  artifactProfiles.forEach((profile) => {
    definitionReference(
      profile,
      ADOPTER_ARTIFACT_PROFILE_INTERFACE,
      "artifact profile",
    );
    if (
      !Array.isArray(profile.kinds) ||
      profile.kinds.length === 0 ||
      profile.kinds.some(
        (kind) => typeof kind !== "string" || kind.length === 0,
      ) ||
      new Set(profile.kinds).size !== profile.kinds.length
    ) {
      throw new TypeError(
        "artifact profile kinds must be a non-empty unique string array",
      );
    }
  });
  const driverRegistry = registry(drivers, "protocol driver");
  const profileRegistry = registry(artifactProfiles, "artifact profile");

  return Object.freeze({
    evaluate(request, context = {}) {
      const issues = validateRequest(request);
      if (issues.length > 0)
        return gateResult(request, null, null, null, null, issues);

      const driver = driverRegistry.get(
        `${request.protocol.id}@${request.protocol.version}`,
      );
      if (!driver) {
        issues.push(
          issue(
            "delivery-driver-unknown",
            "/protocol",
            "No exact protocol driver is registered.",
          ),
        );
      }
      const profile = profileRegistry.get(
        `${request.artifactProfile.id}@${request.artifactProfile.version}`,
      );
      if (!profile) {
        issues.push(
          issue(
            "delivery-artifact-profile-unknown",
            "/artifactProfile",
            "No exact artifact profile is registered.",
          ),
        );
      } else if (!profile.kinds.includes(request.artifact.kind)) {
        issues.push(
          issue(
            "delivery-artifact-kind-mismatch",
            "/artifact/kind",
            "Artifact kind is not admitted by the selected profile.",
          ),
        );
      }

      let profileResult = null;
      if (profile && profile.kinds.includes(request.artifact.kind)) {
        try {
          profileResult = normalizeProfileResult(
            profile.verify(structuredClone(request.artifact)),
          );
        } catch {
          profileResult = {
            valid: false,
            issues: [
              issue(
                "delivery-artifact-profile-error",
                "/artifactProfile",
                "Artifact profile execution failed closed.",
              ),
            ],
          };
        }
        issues.push(...profileResult.issues);
        if (!profileResult.valid && profileResult.issues.length === 0) {
          issues.push(
            issue(
              "delivery-artifact-rejected",
              "/artifact",
              "Artifact profile rejected the artifact.",
            ),
          );
        }
      }

      let driverResult = null;
      if (driver && profileResult?.valid === true) {
        try {
          driverResult = normalizeDriverResult(
            driver.verify({
              request: structuredClone(request),
              context: structuredClone(context),
            }),
          );
        } catch {
          driverResult = {
            valid: false,
            report: null,
            reportRoot: null,
            issues: [
              issue(
                "delivery-driver-error",
                "/protocol",
                "Protocol driver execution failed closed.",
              ),
            ],
          };
        }
        issues.push(...driverResult.issues);
        if (!driverResult.valid && driverResult.issues.length === 0) {
          issues.push(
            issue(
              "delivery-semantic-rejected",
              "/declaration",
              "Protocol driver rejected the declaration.",
            ),
          );
        }
      }
      return gateResult(
        request,
        driver,
        profile,
        profileResult,
        driverResult,
        issues,
      );
    },
  });
}
