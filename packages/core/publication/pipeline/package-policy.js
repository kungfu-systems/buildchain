export function assertPipelinePackagePolicy(pkg) {
  if (
    typeof pkg?.name !== "string" ||
    pkg.name.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(pkg.name)
  )
    throw new Error("npm package name is not a bounded registry identity");
  const config = pkg.publishConfig;
  if (config === undefined) return;
  if (
    !config ||
    Array.isArray(config) ||
    typeof config !== "object" ||
    Object.keys(config).some(
      (key) => !["access", "registry", "tag", "provenance"].includes(key),
    )
  )
    throw new Error(
      "npm publishConfig cannot add provider, credential or execution configuration to the product contract",
    );
  if (
    config.registry !== undefined &&
    !["https://registry.npmjs.org", "https://registry.npmjs.org/"].includes(
      config.registry,
    )
  )
    throw new Error("npm publication requires the declared npmjs provider");
}
