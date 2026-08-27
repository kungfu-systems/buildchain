import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  V4_RUNTIME_SEMANTIC_CLOSURE_PATH,
  validateRuntimeSemanticClosure,
} from "../scripts/check-v4-runtime-semantic-closure.mjs";

const root = path.resolve(import.meta.dirname, "..");

function manifest() {
  return JSON.parse(
    fs.readFileSync(path.join(root, V4_RUNTIME_SEMANTIC_CLOSURE_PATH), "utf8"),
  );
}

test("every reverse-scanned v3 runtime semantic has executable v4 evidence", () => {
  assert.deepEqual(validateRuntimeSemanticClosure({ root }), {
    capabilities: 13,
    evidenceDimensions: 65,
    residualsClosed: 14,
    legacyFallbacks: 0,
    providerDecisionAuthorities: 0,
  });
});

test("runtime semantic closure rejects missing failure evidence", () => {
  const candidate = manifest();
  candidate.capabilities[0].evidence.failure = [];
  assert.throws(
    () => validateRuntimeSemanticClosure({ root, manifest: candidate }),
    /failure evidence is empty/,
  );
});

test("runtime semantic closure rejects legacy fallback and provider authority", () => {
  const candidate = manifest();
  candidate.capabilities[0].legacyFallbackAllowed = true;
  candidate.capabilities[0].providerDecisionAuthorityAllowed = true;
  assert.throws(
    () => validateRuntimeSemanticClosure({ root, manifest: candidate }),
    /legacy fallback must remain disabled.*provider decision authority must remain disabled/s,
  );
});

test("runtime semantic closure rejects residual identity substitution", () => {
  const candidate = manifest();
  candidate.capabilities[0].resolvedResiduals[0].source = "substituted";
  assert.throws(
    () => validateRuntimeSemanticClosure({ root, manifest: candidate }),
    /resolved residual identities do not match the reverse scan/,
  );
});
