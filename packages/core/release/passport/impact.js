import {
  optionalString,
  nonEmptyString,
  IMPACT_LEDGER_CONTRACT,
} from "./identity.js";
import { defaultReleaseImpact as defaultImpact } from "../release-passport-contract.js";
export const VERSION_IMPACT_ORDER = new Map([
  ["unknown", 0],
  ["patch", 1],
  ["minor", 2],
  ["major", 3],
]);
export function normalizeImpactLevel(value, fallback = "unknown") {
  const normalized = optionalString(value || fallback).toLowerCase();
  return VERSION_IMPACT_ORDER.has(normalized)
    ? normalized
    : optionalString(value || fallback);
}
export function highestImpactLevel(levels = []) {
  let highest = "unknown";
  for (const level of levels) {
    const normalized = normalizeImpactLevel(level);
    if (
      (VERSION_IMPACT_ORDER.get(normalized) ?? -1) >
      (VERSION_IMPACT_ORDER.get(highest) ?? -1)
    ) {
      highest = normalized;
    }
  }
  return highest;
}
export function surfaceImpactRequirement({ passport = {}, impact = {} } = {}) {
  const release =
    passport?.release && typeof passport.release === "object"
      ? passport.release
      : {};
  const impactRelease =
    impact?.release && typeof impact.release === "object" ? impact.release : {};
  const channel = optionalString(
    release.channel || impactRelease.channel,
  ).toLowerCase();
  const targetRef = optionalString(
    release.targetRef ||
      release.target_ref ||
      impactRelease.targetRef ||
      impactRelease.target_ref,
  ).toLowerCase();
  if (channel === "release" || targetRef.startsWith("release/")) {
    return {
      required: true,
      type: "production-release",
      reason:
        "production release passports require surfaceImpacts[] so agents can audit the final version impact",
      channel,
      targetRef,
    };
  }
  if (channel === "major" || targetRef === "publish-gate/major") {
    return {
      required: true,
      type: "major-gate",
      reason:
        "major publish gates require surfaceImpacts[] so breaking-surface rationale is explicit",
      channel,
      targetRef,
    };
  }
  return {
    required: false,
    type: channel || (targetRef ? "non-production-release" : "legacy"),
    reason:
      "surfaceImpacts[] is optional for alpha, local, and legacy passport contexts",
    channel,
    targetRef,
  };
}
export function normalizeSurfaceImpact(entry = {}, index = 0) {
  const id = nonEmptyString(
    entry.id || entry.surface || entry.surfaceId,
    `surfaceImpacts[${index}].id`,
  );
  const impact = normalizeImpactLevel(
    entry.impact || entry.classification || entry.versionImpact,
  );
  return {
    id,
    impact,
    class: optionalString(
      entry.class || entry.changeClass || entry.change_class,
    ),
    rationale: optionalString(entry.rationale || entry.reason),
    source: optionalString(entry.source),
  };
}
export function normalizeImpactLedger(
  value = undefined,
  { tag = "", line = "", decision = "unknown" } = {},
) {
  if (!value) {
    return defaultImpact({ tag, line, decision });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("impact must be a JSON object");
  }
  const surfaceImpacts = Array.isArray(value.surfaceImpacts)
    ? value.surfaceImpacts.map((entry, index) =>
        normalizeSurfaceImpact(entry, index),
      )
    : [];
  const finalImpact = normalizeImpactLevel(
    value.versionImpact?.final ||
      value.versionImpact ||
      value.classification ||
      decision,
  );
  return {
    ...value,
    schemaVersion: Number(value.schemaVersion || 1),
    contract: value.contract || IMPACT_LEDGER_CONTRACT,
    release: {
      tag: optionalString(value.release?.tag || tag),
      line: optionalString(value.release?.line || line),
      ...(value.release &&
      typeof value.release === "object" &&
      !Array.isArray(value.release)
        ? value.release
        : {}),
    },
    versionImpact: {
      final: finalImpact,
      source: optionalString(
        value.versionImpact?.source || value.impactSource || "declared",
      ),
      rationale: optionalString(
        value.versionImpact?.rationale || value.rationale || value.summary,
      ),
    },
    surfaceImpacts,
    classification: normalizeImpactLevel(value.classification || finalImpact),
    breaking:
      value.breaking === undefined
        ? finalImpact === "major"
        : Boolean(value.breaking),
    migrationRequired:
      value.migrationRequired === undefined
        ? finalImpact === "major"
        : Boolean(value.migrationRequired),
  };
}
