import {
  ADOPTER_PROTOCOL_DRIVER_INTERFACE,
  adopterDeliveryGateDigest,
  defineAdopterProtocolDriver,
} from "./adopter-delivery-gate.js";
import {
  KFD_LEGACY_SUPPORT_MATRIX_CONTRACT,
  validateKfdAdopterManifestGate,
  validateKfdLegacySupportMatrixProjection,
} from "./kfd-adopter-manifest.js";

export const LEGACY_KFD_ADOPTER_PROTOCOL_ID =
  "buildchain.kfd-adopter/legacy-support-matrix";
export const LEGACY_KFD_ADOPTER_PROTOCOL_VERSION = "1.0.0";
export const LEGACY_KFD_ADOPTER_DRIVER_REPORT_CONTRACT =
  "kungfu-buildchain-legacy-kfd-adopter-driver-report";

function issue(code, path, message) {
  return { code, path, message };
}

function normalizedIssues(entries) {
  return (entries ?? []).map(({ code, path, message }) => ({
    code,
    path: path ? `/${path.replaceAll(".", "/")}` : "/declaration",
    message,
  }));
}

function sameJson(left, right) {
  try {
    return adopterDeliveryGateDigest(left) === adopterDeliveryGateDigest(right);
  } catch {
    return false;
  }
}

function bindingIssues(request, manifest) {
  const issues = [];
  if (
    request.project.instanceId !== manifest?.manifestId ||
    request.project.adopterId !== manifest?.adopter?.id
  ) {
    issues.push(
      issue(
        "delivery-legacy-project-binding-mismatch",
        "/project",
        "Delivery project identity must match the standard adopter manifest.",
      ),
    );
  }
  if (!sameJson(request.artifact, manifest?.adopter?.artifact)) {
    issues.push(
      issue(
        "delivery-legacy-artifact-binding-mismatch",
        "/artifact",
        "Delivery artifact must match the standard adopter manifest artifact.",
      ),
    );
  }
  return issues;
}

function invalidContextResult(issues) {
  const report = {
    schemaVersion: 1,
    contract: LEGACY_KFD_ADOPTER_DRIVER_REPORT_CONTRACT,
    valid: false,
    qualifying: false,
    selfCertified: false,
    independentlyCertified: false,
    manifestRoot: null,
    manifestGateRoot: null,
    legacyProjectionRoot: null,
    legacyProjection: null,
    adapterIssues: issues,
    nonClaims: [
      "The legacy support matrix is a one-way projection, not declaration authority.",
      "Buildchain carries the existing standard manifest decision and does not certify KFD adoption.",
    ],
  };
  return {
    valid: false,
    report,
    reportRoot: adopterDeliveryGateDigest(report),
    issues,
  };
}

export function createLegacyKfdAdopterProtocolDriver() {
  return defineAdopterProtocolDriver({
    interface: ADOPTER_PROTOCOL_DRIVER_INTERFACE,
    id: LEGACY_KFD_ADOPTER_PROTOCOL_ID,
    version: LEGACY_KFD_ADOPTER_PROTOCOL_VERSION,
    verify({ request, context }) {
      const manifest = context?.adopterManifest;
      const manifestGate = context?.adopterManifestGate;
      if (!manifest || !manifestGate) {
        return invalidContextResult([
          issue(
            "delivery-legacy-verification-context-invalid",
            "/protocol",
            "The exact standard adopter manifest and manifest gate are required.",
          ),
        ]);
      }

      const source = manifest?.adopter?.artifact?.coordinate?.match(
        /^([^@\s]+)@([0-9a-f]{40})$/,
      );
      const gateValidation = validateKfdAdopterManifestGate(manifestGate, {
        expectedAdopterId: manifest?.adopter?.id,
        expectedSourceRepository: source?.[1] ?? "",
        expectedSourceSha: source?.[2] ?? "",
        checkedAt: manifestGate?.checkedAt,
      });
      const projectionValidation = validateKfdLegacySupportMatrixProjection(
        request.declaration,
        { manifest, manifestGate },
      );
      const adapterIssues = [
        ...bindingIssues(request, manifest),
        ...normalizedIssues(gateValidation.issues),
        ...normalizedIssues(projectionValidation.issues),
      ];
      if (
        request.declaration?.contract !== KFD_LEGACY_SUPPORT_MATRIX_CONTRACT
      ) {
        adapterIssues.push(
          issue(
            "delivery-legacy-contract-invalid",
            "/declaration/contract",
            `Legacy declaration must use ${KFD_LEGACY_SUPPORT_MATRIX_CONTRACT}.`,
          ),
        );
      }

      const valid =
        gateValidation.valid &&
        projectionValidation.valid &&
        adapterIssues.length === 0;
      const report = {
        schemaVersion: 1,
        contract: LEGACY_KFD_ADOPTER_DRIVER_REPORT_CONTRACT,
        valid,
        qualifying: false,
        selfCertified: false,
        independentlyCertified: false,
        manifestRoot: manifestGate?.authority?.manifestRoot ?? null,
        manifestGateRoot: manifestGate?.gateRoot ?? null,
        legacyProjectionRoot: adopterDeliveryGateDigest(request.declaration),
        legacyProjection: structuredClone(request.declaration),
        adapterIssues,
        nonClaims: [
          "The legacy support matrix is a one-way projection, not declaration authority.",
          "Buildchain carries the existing standard manifest decision and does not certify KFD adoption.",
        ],
      };
      return {
        valid,
        report,
        reportRoot: adopterDeliveryGateDigest(report),
        issues: adapterIssues,
      };
    },
  });
}
