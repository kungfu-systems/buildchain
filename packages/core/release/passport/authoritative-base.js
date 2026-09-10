import { optionalString } from "./identity.js";
export function mergeAuthoritativePassportBase(
  passport,
  basePassport = undefined,
  { requireKfd = false } = {},
) {
  if (!basePassport) {
    if (requireKfd) {
      throw new Error("release passport base with KFD evidence is required");
    }
    return passport;
  }
  if (typeof basePassport !== "object" || Array.isArray(basePassport)) {
    throw new Error("release passport base must be a JSON object");
  }
  const kfdKeys = ["kfd-1", "kfd-2", "kfd-3"];
  const missingKfd = kfdKeys.filter(
    (key) =>
      !basePassport[key] ||
      typeof basePassport[key] !== "object" ||
      Array.isArray(basePassport[key]),
  );
  if (requireKfd && missingKfd.length > 0) {
    throw new Error(
      `release passport base is missing required KFD sections: ${missingKfd.join(", ")}`,
    );
  }
  const merged = passportBaseProjection({ basePassport, passport });
  for (const key of [
    "versionImpact",
    "surfaceImpacts",
    "promotionRouting",
    "v4ConsumerPolicy",
    "v4RuntimeResume",
    "transaction",
    "trustedPublishing",
    "distTagPromotion",
  ])
    if (basePassport[key] !== undefined) merged[key] = basePassport[key];
  if (basePassport.controllerReceipts !== undefined) {
    merged.controllerReceipts = basePassport.controllerReceipts;
  }
  for (const key of kfdKeys) {
    if (
      basePassport[key] &&
      typeof basePassport[key] === "object" &&
      !Array.isArray(basePassport[key])
    ) {
      merged[key] = basePassport[key];
    }
  }
  return merged;
}
export function mergeAuthoritativeImpactBase(impact, basePassport = undefined) {
  if (
    !basePassport ||
    typeof basePassport !== "object" ||
    Array.isArray(basePassport)
  ) {
    return impact;
  }
  const merged = { ...impact };
  if (optionalString(impact?.release?.version)) {
    return merged;
  }
  if (
    basePassport.versionImpact &&
    typeof basePassport.versionImpact === "object" &&
    !Array.isArray(basePassport.versionImpact)
  ) {
    merged.versionImpact = {
      ...(impact.versionImpact &&
      typeof impact.versionImpact === "object" &&
      !Array.isArray(impact.versionImpact)
        ? impact.versionImpact
        : {}),
      ...basePassport.versionImpact,
    };
  }
  if (Array.isArray(basePassport.surfaceImpacts)) {
    merged.surfaceImpacts = basePassport.surfaceImpacts;
  }
  for (const key of [
    "classification",
    "breaking",
    "security",
    "migrationRequired",
    "summary",
  ]) {
    if (basePassport[key] !== undefined) {
      merged[key] = basePassport[key];
    }
  }
  return merged;
}

function passportBaseProjection({ basePassport, passport }) {
  return {
    ...passport,
    release: {
      ...(passport.release &&
      typeof passport.release === "object" &&
      !Array.isArray(passport.release)
        ? passport.release
        : {}),
      ...(basePassport.release &&
      typeof basePassport.release === "object" &&
      !Array.isArray(basePassport.release)
        ? basePassport.release
        : {}),
    },
    evidence: {
      ...(passport.evidence &&
      typeof passport.evidence === "object" &&
      !Array.isArray(passport.evidence)
        ? passport.evidence
        : {}),
      kfd1: basePassport.evidence?.kfd1 || passport.evidence?.kfd1 || "",
      kfd2: basePassport.evidence?.kfd2 || passport.evidence?.kfd2 || "",
      kfd3: basePassport.evidence?.kfd3 || passport.evidence?.kfd3 || "",
    },
  };
}
