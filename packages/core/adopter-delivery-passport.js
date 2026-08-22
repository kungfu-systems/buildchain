import {
  ADOPTER_DELIVERY_GATE_RESULT_CONTRACT,
  adopterDeliveryGateDigest,
} from "./adopter-delivery-gate.js";

export const ADOPTER_DELIVERY_PASSPORT_BINDING_CONTRACT =
  "kungfu-buildchain-adopter-delivery-passport-binding";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;

function issue(code, message, details = {}) {
  return { code, message, details };
}

function validateRootedJson(value, rootField, code, label) {
  const root = value?.[rootField];
  if (!ROOT_PATTERN.test(root ?? "")) {
    return [issue(code, `${label} must be a canonical sha256 root`)];
  }
  try {
    const preimage = structuredClone(value);
    delete preimage[rootField];
    return adopterDeliveryGateDigest(preimage) === root
      ? []
      : [issue(code, `${label} does not match its exact JSON closure`)];
  } catch {
    return [issue(code, `${label} requires finite acyclic JSON`)];
  }
}

function validateGateIdentity(result) {
  const issues = [];
  if (
    result.schemaVersion !== 1 ||
    result.contract !== ADOPTER_DELIVERY_GATE_RESULT_CONTRACT
  ) {
    issues.push(
      issue(
        "adopterDelivery.gateResult.contract",
        "adopter delivery gate result contract is unsupported",
      ),
    );
  }
  if (
    !result.project ||
    !result.artifact ||
    !result.protocol ||
    !result.artifactProfile
  ) {
    issues.push(
      issue(
        "adopterDelivery.gateResult.closure",
        "gate result must retain project, artifact, protocol, and artifact-profile bindings",
      ),
    );
  }
  if (!ROOT_PATTERN.test(result.artifact?.root ?? "")) {
    issues.push(
      issue(
        "adopterDelivery.gateResult.artifact.root",
        "delivery artifact root must be a canonical sha256 root",
      ),
    );
  }
  if (result.qualifying !== false || result.selfCertified !== false) {
    issues.push(
      issue(
        "adopterDelivery.gateResult.nonClaims",
        "delivery evidence must remain non-qualifying and non-self-certifying",
      ),
    );
  }
  return issues;
}

function validatePassedGate(result) {
  if (result.status !== "passed") {
    return result.status === "failed"
      ? []
      : [
          issue(
            "adopterDelivery.gateResult.status",
            "gate status must be passed or failed",
          ),
        ];
  }
  const passed =
    result.protocol?.loaded === true &&
    ROOT_PATTERN.test(result.protocol?.reportRoot ?? "") &&
    result.artifactProfile?.loaded === true &&
    result.artifactProfile?.valid === true &&
    result.semanticReport !== null &&
    (result.issues?.length ?? -1) === 0;
  return passed
    ? []
    : [
        issue(
          "adopterDelivery.gateResult.status",
          "a passed gate must retain successful exact driver and artifact-profile evidence",
        ),
      ];
}

export function validateAdopterDeliveryGateResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {
      valid: false,
      passed: false,
      issues: [
        issue(
          "adopterDelivery.gateResult",
          "adopter delivery gate result must be an object",
        ),
      ],
    };
  }
  const issues = [
    ...validateGateIdentity(result),
    ...validateRootedJson(
      result,
      "gateRoot",
      "adopterDelivery.gateResult.gateRoot",
      "adopter delivery gate root",
    ),
    ...validatePassedGate(result),
  ];
  const valid = issues.length === 0;
  return { valid, passed: valid && result.status === "passed", issues };
}

export function createAdopterDeliveryPassportBinding(gateResult) {
  const normalized = structuredClone(gateResult);
  const validation = validateAdopterDeliveryGateResult(normalized);
  const binding = {
    schemaVersion: 1,
    contract: ADOPTER_DELIVERY_PASSPORT_BINDING_CONTRACT,
    valid: validation.passed,
    qualifying: false,
    selfCertified: false,
    gateResult: normalized,
    validationIssues: validation.issues,
    nonClaims: [
      "A passing adopter delivery gate does not grant runtime permission or release authority.",
      "The selected protocol driver retains semantic authority; Buildchain only binds its exact result into delivery evidence.",
    ],
  };
  binding.bindingRoot = adopterDeliveryGateDigest(binding);
  return binding;
}

export function normalizeAdopterDeliveryPassportBinding(value) {
  if (!value) return undefined;
  return value.contract === ADOPTER_DELIVERY_PASSPORT_BINDING_CONTRACT
    ? structuredClone(value)
    : createAdopterDeliveryPassportBinding(value);
}

export function validateAdopterDeliveryPassportBinding(
  binding,
  { expectedProjectRepository = "" } = {},
) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return [
      issue(
        "adopterDelivery.binding",
        "adopter delivery passport binding must be an object",
      ),
    ];
  }
  const gateValidation = validateAdopterDeliveryGateResult(binding.gateResult);
  const issues = [
    ...validateRootedJson(
      binding,
      "bindingRoot",
      "adopterDelivery.binding.bindingRoot",
      "adopter delivery binding root",
    ),
    ...gateValidation.issues,
  ];
  if (
    binding.schemaVersion !== 1 ||
    binding.contract !== ADOPTER_DELIVERY_PASSPORT_BINDING_CONTRACT
  ) {
    issues.push(
      issue(
        "adopterDelivery.binding.contract",
        "adopter delivery passport binding contract is unsupported",
      ),
    );
  }
  if (
    binding.valid !== gateValidation.passed ||
    binding.qualifying !== false ||
    binding.selfCertified !== false
  ) {
    issues.push(
      issue(
        "adopterDelivery.binding.status",
        "binding status must preserve a passing non-authoritative gate result",
      ),
    );
  }
  if (!gateValidation.passed) {
    issues.push(
      issue(
        "adopterDelivery.status",
        "release passport requires a passed adopter delivery gate",
      ),
    );
  }
  if (
    expectedProjectRepository &&
    binding.gateResult?.project?.adopterId !== expectedProjectRepository
  ) {
    issues.push(
      issue(
        "adopterDelivery.project",
        "delivery project must match the release passport product repository",
      ),
    );
  }
  return issues;
}

function sameJson(left, right) {
  try {
    return adopterDeliveryGateDigest(left) === adopterDeliveryGateDigest(right);
  } catch {
    return false;
  }
}

export function validateAdopterDeliveryReleaseEvidence({
  binding,
  artifactBinding,
  expectedProjectRepository = "",
} = {}) {
  if (!binding && !artifactBinding) return [];
  if (!binding) {
    return [
      issue(
        "adopterDelivery.passport",
        "artifact evidence cannot introduce delivery authority absent from the passport",
      ),
    ];
  }
  const issues = validateAdopterDeliveryPassportBinding(binding, {
    expectedProjectRepository,
  });
  if (!artifactBinding || !sameJson(artifactBinding, binding)) {
    issues.push(
      issue(
        "adopterDelivery.artifactEvidence",
        "passport and artifact evidence must bind the same exact delivery result",
      ),
    );
  }
  return issues;
}
