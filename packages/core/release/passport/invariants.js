import {
  nonEmptyString,
  optionalString,
  INVARIANT_PASSPORT_GATE_CONTRACT,
} from "./identity.js";
import { sha256Text, stableJson } from "./json.js";
export function invariantSemanticPreimage(passport) {
  const value = structuredClone(passport);
  delete value.passportRoot;
  delete value.observedAt;
  return value;
}
export function normalizeInvariantPassport(meta, index = 0) {
  const value = meta?.value;
  const label = `invariantPassportJsons[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  for (const field of [
    "schema",
    "product",
    "canonicalization",
    "passportRoot",
    "contractRoot",
    "registryRoot",
    "verdict",
  ]) {
    nonEmptyString(value[field], `${label}.${field}`);
  }
  if (value.canonicalization !== "stable-json-sha256-v1") {
    throw new Error(`${label}.canonicalization must be stable-json-sha256-v1`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value.passportRoot)) {
    throw new Error(`${label}.passportRoot must be sha256:<64-lowercase-hex>`);
  }
  const expectedRoot = `sha256:${sha256Text(stableJson(invariantSemanticPreimage(value)))}`;
  if (value.passportRoot !== expectedRoot) {
    throw new Error(
      `${label}.passportRoot mismatch: expected ${expectedRoot}, got ${value.passportRoot}`,
    );
  }
  if (value.verdict !== "verified") {
    throw new Error(`${label}.verdict must be verified, got ${value.verdict}`);
  }
  if (value.coverage?.complete !== true) {
    throw new Error(`${label}.coverage.complete must be true`);
  }
  if (value.source?.dirty !== false) {
    throw new Error(`${label}.source.dirty must be false`);
  }
  if (!/^[0-9a-f]{40}$/.test(optionalString(value.source?.revision))) {
    throw new Error(
      `${label}.source.revision must be an exact 40-hex revision`,
    );
  }
  const platforms = Array.isArray(value.coverage?.platforms)
    ? [...new Set(value.coverage.platforms.map(String))].sort()
    : [];
  if (platforms.length === 0)
    throw new Error(`${label}.coverage.platforms must be non-empty`);
  if (!Array.isArray(value.residualRisk))
    throw new Error(`${label}.residualRisk must be an array`);
  return {
    path: optionalString(meta.path),
    sha256: optionalString(meta.sha256),
    schema: value.schema,
    product: value.product,
    passportRoot: value.passportRoot,
    contractRoot: value.contractRoot,
    registryRoot: value.registryRoot,
    verdict: value.verdict,
    source: structuredClone(value.source),
    coverage: structuredClone(value.coverage),
    platforms,
    residualRisk: structuredClone(value.residualRisk),
  };
}
export function createInvariantPassportGate(passportMetas = []) {
  const passports = passportMetas
    .filter((meta) => meta?.value)
    .map(normalizeInvariantPassport);
  if (passports.length === 0) return undefined;
  return {
    contract: INVARIANT_PASSPORT_GATE_CONTRACT,
    result: "passed",
    passports,
    responsibility: {
      invariantSemanticsOwner: "consumer",
      passportVerificationOwner: "consumer",
      releaseAdmissionOwner: "Buildchain",
    },
  };
}
