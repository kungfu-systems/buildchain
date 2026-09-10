export function commonEnv(plan, platform) {
  return {
    ...platform?.environment,
    BUILDCHAIN_SOURCE_REPOSITORY: plan.run.repository,
    BUILDCHAIN_SOURCE_SHA: plan.source.sha,
    BUILDCHAIN_SOURCE_TREE_SHA: plan.source.tree_sha,
    BUILDCHAIN_SOURCE_REF: plan.source.ref,
    BUILDCHAIN_RUNTIME_REPOSITORY: plan.identity.repository,
    BUILDCHAIN_RUNTIME_SHA: plan.identity.sha,
    BUILDCHAIN_RUNTIME_REF: plan.identity.ref,
    BUILDCHAIN_PLATFORM_ID: platform?.id || "",
    BUILDCHAIN_PLATFORM_NAME: platform?.name || "",
    BUILDCHAIN_ARTIFACT_NAME: plan.artifacts.name,
    BUILDCHAIN_DEPENDENCY_LOCK_ROOT: plan.cache.dependency_root,
    BUILDCHAIN_TOOLCHAIN_ROOT: plan.cache.toolchain_root,
    BUILDCHAIN_CACHE_POLICY_ROOT: plan.cache.policy_root,
  };
}
