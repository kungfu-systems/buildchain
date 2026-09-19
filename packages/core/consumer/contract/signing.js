import {
  choice,
  list,
  object,
  relativePath,
  slug,
  text,
  unique,
} from "./shape.js";

// Signature intent contains no credential, provider-effect or runner inputs.
// Every declared signature is required; absence never means unsigned fallback.
export function compileProductSigning(value, product, artifacts, location) {
  if (value === undefined) {
    if (product.finalize !== undefined)
      throw new Error(
        `${location}: finalization requires declared native signing`,
      );
    return undefined;
  }
  if (
    product.type !== "binary" ||
    product.platforms.some((p) => !p.startsWith("macos-"))
  )
    throw new Error(
      `${location}: Apple signing requires a macOS binary product`,
    );
  const rules = list(value, location, (rule, field) => {
    object(
      rule,
      ["artifact", "profile", "kind"],
      [
        "path",
        "bundle_id",
        "installer",
        "entitlements_profile",
        "entitlements_paths",
      ],
      field,
    );
    slug(rule.artifact, `${field}.artifact`);
    choice(rule.profile, ["apple-developer-id"], `${field}.profile`);
    choice(rule.kind, ["archive", "app-bundle"], `${field}.kind`);
    const primary = artifacts.find((item) => item.id === rule.artifact);
    if (primary?.kind !== "archive")
      throw new Error(
        `${field}.artifact: signing must bind a declared archive`,
      );
    if (rule.kind === "app-bundle") {
      relativePath(rule.path, `${field}.path`);
      text(
        rule.bundle_id,
        `${field}.bundle_id`,
        /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u,
      );
      if (rule.path.includes("*") || rule.bundle_id !== rule.bundle_id.trim())
        throw new Error(
          `${field}: app signing requires exact path and bundle identity`,
        );
      slug(rule.installer, `${field}.installer`);
      const installer = artifacts.find((item) => item.id === rule.installer);
      if (
        !rule.path.endsWith(".app") ||
        !primary.path.endsWith(".zip") ||
        installer?.kind !== "installer" ||
        !installer.path.endsWith(".dmg")
      )
        throw new Error(
          `${field}: app signing requires an app path and declared ZIP/DMG pair`,
        );
      if (
        rule.entitlements_profile !== undefined ||
        rule.entitlements_paths !== undefined
      )
        throw new Error(
          `${field}: app entitlements belong to the credential island`,
        );
    } else {
      if (
        ["path", "bundle_id", "installer"].some((key) =>
          Object.hasOwn(rule, key),
        )
      )
        throw new Error(
          `${field}: archive signing cannot declare app assembly inputs`,
        );
      if (!/\.(?:tar\.gz|tgz|zip)$/u.test(primary.path))
        throw new Error(
          `${field}: native archive signer does not support this format`,
        );
      const profile = rule.entitlements_profile ?? "none";
      choice(
        profile,
        ["none", "jit-executable-v1"],
        `${field}.entitlements_profile`,
      );
      if (profile === "none" && rule.entitlements_paths !== undefined)
        throw new Error(`${field}: entitlements paths require the JIT profile`);
      if (profile !== "none") {
        list(
          rule.entitlements_paths,
          `${field}.entitlements_paths`,
          relativePath,
        );
        unique(rule.entitlements_paths, `${field}.entitlements_paths`);
        if (rule.entitlements_paths.some((p) => p.includes("*")))
          throw new Error(
            `${field}: entitlements paths must identify exact files`,
          );
      }
    }
    return structuredClone(rule);
  });
  unique(
    rules.flatMap((rule) => [
      rule.artifact,
      ...(rule.installer ? [rule.installer] : []),
    ]),
    location,
  );
  if (rules.length > 32)
    throw new Error(`${location}: signing request inventory exceeds its bound`);
  return rules;
}
