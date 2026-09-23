import fs from "node:fs";
import path from "node:path";
import {
  createKfd1ReleaseGateEvidence,
  normalizeKfd1ContractWorldWitness,
  createKfd3CollaborationInterfaceReleaseGateEvidence,
} from "../../adoption/kfd-gate.js";
import { createKfd2ReleaseTrustPassportAudit } from "../passport/trust-claims.js";
import { normalizeImpactLedger } from "../passport/impact.js";
import { historicalEvidenceFileKeys } from "./compatibility-context.js";

function containedFile(root, relative) {
  const candidate = path.resolve(root, relative);
  const boundary = `${fs.realpathSync(root)}${path.sep}`;
  if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error("Historical evidence path escapes its declared directory");
  if (!fs.existsSync(candidate)) return candidate;
  if (!fs.realpathSync(candidate).startsWith(boundary))
    throw new Error(
      "Historical evidence symlink escapes its declared directory",
    );
  if (!fs.statSync(candidate).isFile())
    throw new Error("Historical evidence requires a regular file");
  return candidate;
}

function readValues(input, sourceDirectory) {
  if (!input) return [];
  const entries = /^[\s]*[\[{]/u.test(input)
    ? [input]
    : input
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
  return entries.flatMap((entry) => {
    const value = JSON.parse(
      /^[\s]*[\[{]/u.test(entry)
        ? entry
        : fs.readFileSync(containedFile(sourceDirectory, entry), "utf8"),
    );
    return Array.isArray(value) ? value : [value];
  });
}

export function historicalEvidenceFiles(inputs, sourceDirectory) {
  return Object.fromEntries(
    historicalEvidenceFileKeys
      .filter((key) => inputs[key])
      .map((key) => [key, readValues(inputs[key], sourceDirectory)]),
  );
}

export function qualifyHistoricalEvidenceFiles({
  files,
  results,
  sourceDirectory,
  candidateDirectory,
  verifiedAt,
}) {
  const [kfd1Key, kfd2Key, prebuildKey, artifactKey, impactKey] =
    historicalEvidenceFileKeys;
  const witnesses = files[kfd1Key] || [];
  // The maintained KFD-1 resolver can use source surfaces or payload surfaces.
  // Validate both roots before giving it consumer-declared paths.
  for (const witness of witnesses.map((value) =>
    normalizeKfd1ContractWorldWitness(value),
  ))
    for (const surface of witness.surfaces || []) {
      if (surface.sourcePath)
        containedFile(sourceDirectory, surface.sourcePath);
      if (surface.artifactPath) {
        containedFile(sourceDirectory, surface.artifactPath);
        containedFile(
          path.join(candidateDirectory, "payloads"),
          surface.artifactPath,
        );
      }
    }
  const kfd1 = createKfd1ReleaseGateEvidence({
    cwd: sourceDirectory,
    artifactRoot: path.join(candidateDirectory, "payloads"),
    witnesses,
    verifiedAt,
  })?.passportSection;
  const commandWitness =
    results["release-passport-kfd-3-artifact-verify-command"];
  const kfd3 = createKfd3CollaborationInterfaceReleaseGateEvidence({
    prebuildWitnesses: files[prebuildKey] || [],
    artifactWitnesses: [
      ...(files[artifactKey] || []),
      ...(commandWitness ? [commandWitness] : []),
    ],
    verifiedAt,
  })?.passportSection;
  const kfd2 = createKfd2ReleaseTrustPassportAudit({
    explicitClaims: files[kfd2Key] || [],
    kfd1Section: kfd1,
    kfd3Section: kfd3,
    verifiedAt,
  });
  const gates = Object.fromEntries(
    Object.entries({ kfd1, kfd3, kfd2 }).filter(([, value]) => value),
  );
  for (const [key, gate] of Object.entries(gates))
    if (gate.status === "failed")
      throw new Error(`Historical ${key} release evidence failed`);
  if (files[impactKey])
    gates.impact = files[impactKey].map((value) =>
      normalizeImpactLedger(value),
    );
  return JSON.parse(JSON.stringify(gates));
}
