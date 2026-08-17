import crypto from "node:crypto";

import authority from "./authority.json" with { type: "json" };

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function ledgerSemanticRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function ledgerAuthorityRoot(value = authority) {
  const preimage = structuredClone(value);
  delete preimage.authorityRoot;
  return ledgerSemanticRoot(preimage);
}

export function ledgerEvidenceRoot({ claim, project, artifactRoot }) {
  return ledgerSemanticRoot({
    schemaVersion: 1,
    claim,
    subject: { project, artifactRoot },
    observation: "verified",
  });
}

function issue(code, path, message) {
  return { code, path, message };
}

function exactObject(value, fields) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function validSpecificationShape(specification) {
  if (
    !exactObject(specification, [
      "schema",
      "authorityRoot",
      "project",
      "artifactRoot",
      "claims",
      "evidence",
    ]) ||
    specification.schema !== "ledger-specification/v1" ||
    !Array.isArray(specification.claims) ||
    specification.claims.length === 0 ||
    specification.claims.some((claim) => typeof claim !== "string") ||
    new Set(specification.claims).size !== specification.claims.length ||
    !Array.isArray(specification.evidence)
  ) {
    return false;
  }
  return true;
}

export function verifyLedgerSpecification(request) {
  const declaration = request?.declaration;
  const specification = declaration?.specification;
  const issues = [];

  if (
    !exactObject(declaration, ["specification"]) ||
    !validSpecificationShape(specification)
  ) {
    issues.push(
      issue(
        "ledger-schema-mismatch",
        "/declaration/specification",
        "The declaration must match the exact ledger specification schema.",
      ),
    );
  } else {
    if (
      !ROOT_PATTERN.test(specification.authorityRoot) ||
      specification.authorityRoot !== authority.authorityRoot ||
      ledgerAuthorityRoot() !== authority.authorityRoot
    ) {
      issues.push(
        issue(
          "ledger-authority-root-mismatch",
          "/declaration/specification/authorityRoot",
          "The declaration must bind the exact rooted ledger authority.",
        ),
      );
    }
    if (
      specification.project !== authority.project ||
      specification.project !== request?.project?.adopterId
    ) {
      issues.push(
        issue(
          "ledger-project-binding-mismatch",
          "/declaration/specification/project",
          "The specification project must match both authority and adopter.",
        ),
      );
    }
    if (specification.artifactRoot !== request?.artifact?.root) {
      issues.push(
        issue(
          "ledger-artifact-root-mismatch",
          "/declaration/specification/artifactRoot",
          "The specification must bind the exact delivered artifact root.",
        ),
      );
    }

    const admittedClaims = new Set(authority.claims);
    const selectedClaims = new Set(specification.claims);
    const evidenceByClaim = new Map();
    for (const entry of specification.evidence) {
      if (
        !exactObject(entry, ["claim", "root"]) ||
        typeof entry.claim !== "string" ||
        !ROOT_PATTERN.test(entry.root)
      ) {
        issues.push(
          issue(
            "ledger-evidence-invalid",
            "/declaration/specification/evidence",
            "Every evidence entry must bind one claim to one canonical root.",
          ),
        );
        continue;
      }
      evidenceByClaim.set(entry.claim, entry.root);
    }
    if (
      evidenceByClaim.size !== specification.evidence.length ||
      specification.evidence.length !== specification.claims.length ||
      specification.evidence.some((entry) => !selectedClaims.has(entry?.claim))
    ) {
      issues.push(
        issue(
          "ledger-evidence-invalid",
          "/declaration/specification/evidence",
          "Evidence must bind each selected claim exactly once and no others.",
        ),
      );
    }

    for (const claim of specification.claims) {
      if (!admittedClaims.has(claim)) {
        issues.push(
          issue(
            "ledger-claim-unknown",
            "/declaration/specification/claims",
            "The ledger authority does not admit the requested claim.",
          ),
        );
        continue;
      }
      const expectedRoot = ledgerEvidenceRoot({
        claim,
        project: specification.project,
        artifactRoot: specification.artifactRoot,
      });
      if (evidenceByClaim.get(claim) !== expectedRoot) {
        issues.push(
          issue(
            "ledger-evidence-root-mismatch",
            "/declaration/specification/evidence",
            "Claim evidence must match the ledger verifier's exact root.",
          ),
        );
      }
    }
  }

  const report = {
    schemaVersion: 1,
    protocol: authority.protocol,
    authorityRoot: authority.authorityRoot,
    project: specification?.project ?? null,
    artifactRoot: specification?.artifactRoot ?? null,
    claims: Array.isArray(specification?.claims) ? specification.claims : [],
    valid: issues.length === 0,
  };
  return {
    valid: issues.length === 0,
    report,
    reportRoot: ledgerSemanticRoot(report),
    issues,
  };
}
