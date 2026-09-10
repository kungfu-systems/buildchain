export function urlsFromResult(result = {}) {
  const urls =
    result.urls && typeof result.urls === "object" ? result.urls : {};
  if (Object.keys(urls).length > 0) return urls;
  return result.url ? { default: result.url } : {};
}

export function compactProductionReleasePrSummary(result = {}) {
  const manifest =
    result.manifest && typeof result.manifest === "object"
      ? result.manifest
      : {};
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-production-release-pr-summary",
    sourceContract: result.contract || "",
    channel: result.channel || manifest.channel || "",
    alias: result.alias || manifest.alias || "",
    status: result.status || "",
    applyMode: result.applyMode || "",
    actor: result.actor || "",
    runId: result.runId || "",
    appliedAt: result.appliedAt || "",
    url: result.url || "",
    urls: urlsFromResult(result),
    sourceSha: result.sourceSha || manifest.sourceSha || "",
    artifactHash: result.artifactHash || manifest.artifactHash || "",
    target: result.target || "",
    manifestKey: result.manifestKey || "",
    surfaceBindings: Array.isArray(result.surfaceBindings)
      ? result.surfaceBindings.map((binding) => ({
          surface: binding.surface || "",
          pathPrefix: binding.pathPrefix || "",
          objectPrefix: binding.objectPrefix || "",
          url: binding.url || "",
          manifestKey: binding.manifestKey || "",
          accessControl: binding.accessControl || "",
          healthStrategy: binding.healthStrategy || "",
        }))
      : [],
  };
}
