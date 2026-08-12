import vectorSuite from "./adopter-delivery-vectors.json" with { type: "json" };

import { adopterDeliveryGateDigest } from "./adopter-delivery-gate.js";

export const ADOPTER_DELIVERY_VECTOR_SUITE_CONTRACT =
  "kungfu-buildchain-adopter-delivery-vectors/v1";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_CASES = new Map([
  ["golden-two-driver-offline-replay", "golden"],
  ["negative-driver-mismatch", "negative"],
  ["negative-category-conflict", "negative"],
  ["negative-evidence-substitution", "negative"],
  ["negative-stale-package-cut", "negative"],
  ["fault-driver-throw", "fault"],
]);

function freezeJson(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeJson(child);
  }
  return value;
}

function issue(code, path, message) {
  return { code, path, message };
}

function suiteDigest(suite) {
  const preimage = structuredClone(suite);
  delete preimage.suiteRoot;
  return adopterDeliveryGateDigest(preimage);
}

export function validateAdopterDeliveryVectorSuite(suite) {
  const issues = [];
  if (!suite || typeof suite !== "object" || Array.isArray(suite)) {
    return {
      valid: false,
      issues: [
        issue(
          "adopter-delivery-vectors.invalid",
          "/",
          "Vector suite must be a JSON object.",
        ),
      ],
    };
  }
  if (
    suite.schemaVersion !== 1 ||
    suite.contract !== ADOPTER_DELIVERY_VECTOR_SUITE_CONTRACT
  ) {
    issues.push(
      issue(
        "adopter-delivery-vectors.contract",
        "/contract",
        "Vector suite contract is unsupported.",
      ),
    );
  }
  if (!Array.isArray(suite.cases)) {
    issues.push(
      issue(
        "adopter-delivery-vectors.cases",
        "/cases",
        "Vector suite cases must be an array.",
      ),
    );
  } else {
    const seen = new Set();
    for (const [index, entry] of suite.cases.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        issues.push(
          issue(
            "adopter-delivery-vectors.case",
            `/cases/${index}`,
            "Vector case must be an object.",
          ),
        );
        continue;
      }
      if (typeof entry.id !== "string" || seen.has(entry.id)) {
        issues.push(
          issue(
            "adopter-delivery-vectors.case-id",
            `/cases/${index}/id`,
            "Vector case id must be non-empty and unique.",
          ),
        );
      }
      seen.add(entry.id);
      if (!entry.expected || typeof entry.expected !== "object") {
        issues.push(
          issue(
            "adopter-delivery-vectors.expected",
            `/cases/${index}/expected`,
            "Vector case must declare its expected result.",
          ),
        );
      }
    }
    for (const [id, className] of REQUIRED_CASES) {
      const entry = suite.cases.find((candidate) => candidate?.id === id);
      if (!entry || entry.class !== className) {
        issues.push(
          issue(
            "adopter-delivery-vectors.required-case",
            "/cases",
            `Required ${className} vector ${id} is missing.`,
          ),
        );
      }
    }
  }
  if (!ROOT_PATTERN.test(suite.suiteRoot ?? "")) {
    issues.push(
      issue(
        "adopter-delivery-vectors.root",
        "/suiteRoot",
        "Vector suite root must be a canonical sha256 root.",
      ),
    );
  } else {
    try {
      if (suiteDigest(suite) !== suite.suiteRoot) {
        issues.push(
          issue(
            "adopter-delivery-vectors.root",
            "/suiteRoot",
            "Vector suite root does not match the exact JSON closure.",
          ),
        );
      }
    } catch {
      issues.push(
        issue(
          "adopter-delivery-vectors.root",
          "/suiteRoot",
          "Vector suite must contain finite acyclic JSON.",
        ),
      );
    }
  }
  return { valid: issues.length === 0, issues };
}

export const ADOPTER_DELIVERY_VECTOR_SUITE = freezeJson(
  structuredClone(vectorSuite),
);

export function getAdopterDeliveryVector(id) {
  const entry = ADOPTER_DELIVERY_VECTOR_SUITE.cases.find(
    (candidate) => candidate.id === id,
  );
  if (!entry) throw new RangeError(`Unknown adopter delivery vector: ${id}`);
  return structuredClone(entry);
}
