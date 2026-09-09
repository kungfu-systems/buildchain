import { requireValue } from "../../runtime/action-process.mjs";

export function requireImmutableAuthority(env) {
  requireValue(
    /^[0-9a-f]{40}$/i.test(env.BUILDCHAIN_AUTHORITY_REF || ""),
    "Publication authority requires an exact 40-character GitHub commit SHA",
  );
}
export function requireSealedInputs(env) {
  const names = [
    "BUILDCHAIN_PUBLICATION_ADMISSION_JSON",
    "BUILDCHAIN_RUNNER_PROVENANCE_JSON",
    "BUILDCHAIN_CONTROL_PLANE_AUDIT_JSON",
    "BUILDCHAIN_GATE_AGGREGATE_JSON",
    "BUILDCHAIN_PUBLICATION_EXPECTED_JSON",
  ];
  const missing = names.filter((name) => !env[name]);
  requireValue(
    !missing.length,
    `Sealed publication evidence unavailable: missing ${missing.join(",")}. Product publication denied before artifact download; publisher credentials have not been evaluated.`,
  );
}
export function requireManagedInputs(env) {
  const value = (key) => env[`BUILDCHAIN_${key}`] || "";
  requireValue(
    value("REPOSITORY") === "kungfu-systems/buildchain",
    "Automatic publication admission requires the canonical Buildchain authority repository",
  );
  requireValue(
    /^[0-9a-f]{40}$/i.test(value("SOURCE_SHA")),
    "Automatic publication admission requires an exact source SHA",
  );
  requireValue(
    /^(alpha|release)\/v[0-9]+\/v[0-9]+\.[0-9]+$/.test(value("TARGET_REF")) ||
      value("TARGET_REF") === "publish-gate/major",
    "Automatic publication admission target must be a current managed channel",
  );
  requireValue(
    Boolean(value("PUBLICATION_VERSION")),
    "Automatic publication admission requires an exact planned publication version",
  );
  if (value("CONSUMER_QUALIFICATION_REQUIRED") === "true")
    requireValue(
      Boolean(value("CONSUMER_PREDICATE_ID")) &&
        /^[0-9a-f]{64}$/i.test(value("CONSUMER_PREDICATE_DIGEST")),
      "Consumer qualification requires an exact predicate id and SHA-256 command digest",
    );
  if (value("CONSUMER_GATE_CONTROLLER_SHA"))
    requireValue(
      /^[0-9a-f]{40}$/i.test(value("CONSUMER_GATE_CONTROLLER_SHA")) &&
        Boolean(value("CONSUMER_GATE_COMMAND")),
      "Consumer Gate controller requires an exact commit and command",
    );
  const kind = value("AUTO_ADMISSION_KIND");
  requireValue(
    [
      "release-candidate",
      "publication-artifact",
      "binary-release-assets",
    ].includes(kind),
    `Unsupported automatic admission kind: ${kind}`,
  );
  if (kind === "binary-release-assets") {
    requireValue(
      value("EVIDENCE_REPOSITORY") === "kungfu-systems/buildchain",
      "Binary release evidence must belong to the canonical Buildchain repository",
    );
    requireValue(
      value("PUBLISHER_WORKFLOW_PATH") ===
        ".github/workflows/.release-binary-assets.yml",
      "Binary release admission requires the sealed binary publisher workflow",
    );
    requireValue(
      Number(Boolean(value("GATE_AGGREGATE_JSON"))) +
        Number(value("AUTO_NO_GATE") === "true") ===
        1,
      "Binary release admission requires exactly one Gate aggregate or explicit no-Gate decision",
    );
    return;
  }
  requireValue(
    value("EVIDENCE_REPOSITORY") === env.GITHUB_REPOSITORY,
    "Publication admission evidence must belong to the caller repository",
  );
  requireValue(
    /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(
      value("PUBLISHER_WORKFLOW_PATH"),
    ),
    "Publication admission requires a repository-local publisher workflow path",
  );
  if (kind !== "release-candidate") return;
  const target = value("PUBLICATION_TARGET"),
    packageName = value("PACKAGE_NAME");
  requireValue(
    (Boolean(packageName) && target === `npm:${packageName}`) ||
      (!packageName && target === `github-release:${env.GITHUB_REPOSITORY}`),
    "Release-candidate admission requires an exact npm or GitHub Release target and matching package name",
  );
  const sources =
    Number(Boolean(value("GATE_AGGREGATE_JSON"))) +
    Number(value("AUTO_NO_GATE") === "true") +
    Number(Boolean(value("CONSUMER_GATE_COMMAND")));
  requireValue(
    sources === 1,
    "Release-candidate admission requires exactly one Gate aggregate, consumer Gate command, or explicit no-Gate decision",
  );
}
