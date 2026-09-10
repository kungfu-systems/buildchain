import { optionalString } from "./identity.js";
import {
  normalizeImpactLevel,
  highestImpactLevel,
  surfaceImpactRequirement,
  VERSION_IMPACT_ORDER,
} from "./impact.js";
import { issue } from "./issues.js";
import { stableJson } from "./json.js";
export function createReleaseImpactContext({ passport, impact }) {
  const surfaceImpacts = Array.isArray(impact?.surfaceImpacts)
    ? impact.surfaceImpacts
    : [];
  const passportSurfaceImpacts = Array.isArray(passport?.surfaceImpacts)
    ? passport.surfaceImpacts
    : [];
  const impactRelease =
    impact?.release &&
    typeof impact.release === "object" &&
    !Array.isArray(impact.release)
      ? impact.release
      : {};
  const passportVersion = optionalString(
    passport?.release?.publishedVersion || passport?.release?.package?.version,
  );
  const passportTargetRef = optionalString(
    passport?.release?.targetRef || passport?.release?.target_ref,
  );
  const passportTargetLineMatch = passportTargetRef.match(
    /^(?:alpha|release)\/v(\d+)\/v\1\.(\d+)$/,
  );
  return {
    surfaceImpacts,
    passportSurfaceImpacts,
    impactVersion: optionalString(impactRelease.version),
    impactLine: optionalString(impactRelease.line),
    passportVersion,
    passportLine: optionalString(
      passport?.release?.line ||
        (passportTargetLineMatch
          ? `v${passportTargetLineMatch[1]}.${passportTargetLineMatch[2]}`
          : ""),
    ),
    impactClassification: normalizeImpactLevel(impact?.classification),
    declaredFinalImpact: normalizeImpactLevel(
      impact?.versionImpact?.final || impact?.classification,
    ),
    computedFinalImpact: highestImpactLevel(
      surfaceImpacts.map((entry) => entry.impact),
    ),
    requiredSurfaceImpacts: surfaceImpactRequirement({ passport, impact }),
  };
}
export function validateReleaseImpact({ passport, impact, context, issues }) {
  const {
    surfaceImpacts,
    passportSurfaceImpacts,
    impactVersion,
    impactLine,
    passportVersion,
    passportLine,
    impactClassification,
    declaredFinalImpact,
    computedFinalImpact,
    requiredSurfaceImpacts,
  } = context;
  if (impactVersion) {
    if (!impactLine) {
      issues.push(
        issue(
          "error",
          "impact.release.line",
          "version-bound impact requires release.line",
        ),
      );
    } else if (passportLine && impactLine !== passportLine) {
      issues.push(
        issue(
          "error",
          "impact.release.line",
          "impact release line must match the release passport line",
          {
            impactLine,
            passportLine,
          },
        ),
      );
    }
    if (passportVersion && impactVersion !== passportVersion) {
      issues.push(
        issue(
          "error",
          "impact.release.version",
          "impact release version must match the published release version",
          {
            impactVersion,
            passportVersion,
          },
        ),
      );
    }
    if (!["patch", "minor", "major"].includes(impactClassification)) {
      issues.push(
        issue(
          "error",
          "impact.classification",
          "version-bound impact classification must be patch, minor, or major",
        ),
      );
    } else if (impactClassification !== declaredFinalImpact) {
      issues.push(
        issue(
          "error",
          "impact.classification",
          "version-bound impact classification must match versionImpact.final",
          {
            classification: impactClassification,
            versionImpact: declaredFinalImpact,
          },
        ),
      );
    }
    if (!optionalString(impact?.summary).trim()) {
      issues.push(
        issue(
          "error",
          "impact.summary",
          "version-bound impact summary is required",
        ),
      );
    }
    if (surfaceImpacts.length === 0) {
      issues.push(
        issue(
          "error",
          "impact.surfaceImpacts.required",
          "version-bound impact requires surfaceImpacts[]",
          {
            type: "version-bound-release-impact",
          },
        ),
      );
    }
  }
  if (requiredSurfaceImpacts.required && surfaceImpacts.length === 0) {
    issues.push(
      issue(
        "error",
        "impact.surfaceImpacts.required",
        "surfaceImpacts[] is required for this release passport type",
        requiredSurfaceImpacts,
      ),
    );
  }
  if (surfaceImpacts.length > 0) {
    for (const [index, entry] of surfaceImpacts.entries()) {
      if (!entry.id) {
        issues.push(
          issue(
            "error",
            `impact.surfaceImpacts[${index}].id`,
            "surface impact id is required",
          ),
        );
      }
      if (!VERSION_IMPACT_ORDER.has(entry.impact)) {
        issues.push(
          issue(
            "error",
            `impact.surfaceImpacts[${index}].impact`,
            "surface impact must be patch, minor, or major",
          ),
        );
      }
      if (!entry.rationale) {
        issues.push(
          issue(
            "error",
            `impact.surfaceImpacts[${index}].rationale`,
            "surface impact rationale is required",
          ),
        );
      }
    }
    if (!impact?.versionImpact?.rationale) {
      issues.push(
        issue(
          "error",
          "impact.versionImpact.rationale",
          "version impact rationale is required when surface impacts are supplied",
        ),
      );
    }
    if (declaredFinalImpact !== computedFinalImpact) {
      issues.push(
        issue(
          "error",
          "impact.versionImpact.final",
          "versionImpact.final must equal the highest surface impact",
          {
            declared: declaredFinalImpact,
            computed: computedFinalImpact,
          },
        ),
      );
    }
    if (stableJson(passportSurfaceImpacts) !== stableJson(surfaceImpacts)) {
      issues.push(
        issue(
          "error",
          "passport.surfaceImpacts",
          "passport.surfaceImpacts must mirror impact.surfaceImpacts",
        ),
      );
    }
  }
  if (
    passport?.versionImpact?.final &&
    impact?.versionImpact?.final &&
    passport.versionImpact.final !== impact.versionImpact.final
  ) {
    issues.push(
      issue(
        "error",
        "passport.versionImpact.final",
        "passport.versionImpact.final must match impact.versionImpact.final",
      ),
    );
  }
}
