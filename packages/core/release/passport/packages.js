import { optionalString } from "./identity.js";
export function normalizePackageEntry(entry = {}) {
  return {
    name: optionalString(entry.name),
    version: optionalString(entry.version || entry.ref),
    distTag: optionalString(entry.distTag || entry.dist_tag),
    digest: optionalString(
      entry.digest || entry.integrity || entry.sha256 || entry.shasum,
    ),
    registry: optionalString(entry.registry),
    platform: optionalString(entry.platform),
    action: optionalString(entry.action),
  };
}
export function normalizePackageSet(
  value = undefined,
  { packageName = "", packageVersion = "", publish = {} } = {},
) {
  if (!value) {
    return undefined;
  }
  const rawMain = value.main ||
    value.mainPackage || {
      name: value.main_package || packageName,
      version: value.version || packageVersion,
      distTag: value.distTag || value.dist_tag || publish.distTag,
    };
  const platforms = Array.isArray(value.platforms)
    ? value.platforms
        .map((entry) => normalizePackageEntry(entry))
        .filter((entry) => entry.name || entry.version)
    : [];
  return {
    order: optionalString(
      value.order ||
        value.packageSetOrder ||
        value.package_set_order ||
        publish.packageSetOrder,
    ),
    registry: optionalString(value.registry || publish.registry),
    main: normalizePackageEntry(rawMain),
    platforms,
  };
}
export function packageSetEntries(packageSet = undefined) {
  if (!packageSet) {
    return [];
  }
  return [
    ...(packageSet.main?.name ? [{ role: "main", ...packageSet.main }] : []),
    ...(packageSet.platforms || []).map((entry) => ({
      role: "platform",
      ...entry,
    })),
  ];
}
export function normalizePublishSummary({
  packageSet = undefined,
  publishEvidence = undefined,
  publish = {},
} = {}) {
  const packages = packageSetEntries(packageSet);
  if (packages.length === 0) {
    return undefined;
  }
  const artifacts = publishEvidence?.artifacts || [];
  const artifactByPackage = new Map(
    artifacts.map((artifact) => [
      [artifact.name, artifact.ref || artifact.version || ""].join("\0"),
      artifact,
    ]),
  );
  const normalizedPackages = packages.map((entry) => {
    const artifact =
      artifactByPackage.get([entry.name, entry.version].join("\0")) || {};
    return {
      role: entry.role,
      name: entry.name,
      publishedVersion: entry.version,
      distTag: entry.distTag,
      digest: entry.digest || artifact.digest || "",
      registry: entry.registry || packageSet.registry || publish.registry || "",
      platform: entry.platform || "",
      action: entry.action || artifact.action || "",
    };
  });
  const distTags = [
    ...new Set(
      normalizedPackages.map((entry) => entry.distTag).filter(Boolean),
    ),
  ];
  return {
    registry: optionalString(packageSet.registry || publish.registry),
    channel: optionalString(publishEvidence?.channel || publish.channel),
    distTag: distTags.length === 1 ? distTags[0] : "",
    source: "packageSet+publishEvidence",
    packages: normalizedPackages,
  };
}
export function normalizeTrustedPublishing(
  value = undefined,
  { workflow = {}, publish = {} } = {},
) {
  if (!value && publish.auth !== "trusted-publishing") {
    return undefined;
  }
  const raw = value || {};
  return {
    provider: optionalString(raw.provider || "npm"),
    enabled:
      raw.enabled === undefined
        ? publish.auth === "trusted-publishing"
        : Boolean(raw.enabled),
    auth: optionalString(raw.auth || publish.auth),
    workflowRunId: optionalString(
      raw.workflowRunId || raw.workflow_run_id || workflow.runId,
    ),
    workflowRunAttempt: optionalString(
      raw.workflowRunAttempt || raw.workflow_run_attempt || workflow.runAttempt,
    ),
    evidence: optionalString(raw.evidence),
  };
}
