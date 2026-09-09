import { requireValue } from "../../runtime/action-process.mjs";

export function sourceCoordinates(env) {
  const branch = env.INPUT_TARGET_BRANCH || env.GITHUB_REF_NAME || "";
  requireValue(
    /^dev\/v\d+\/v\d+\.\d+$/u.test(branch),
    "target-branch must be a semver dev branch",
  );
  requireValue(
    ["off", "shadow", "required"].includes(env.WARRANT_MODE),
    "delivery-warrant-mode must be off, shadow, or required",
  );
  if (env.WARRANT_MODE !== "off") {
    requireValue(
      /^[1-9]\d*$/u.test(env.EXPECTED_PR || "") &&
        /^[0-9a-f]{40}$/u.test(env.EXPECTED_HEAD || ""),
      "delivery Warrant requires an exact PR number and head",
    );
  }
  requireValue(
    env.WARRANT_MODE !== "required" || env.DRY_RUN !== "true",
    "required delivery Warrant mode cannot be combined with dry-run",
  );
  return { branch, "branch-artifact": branch.replaceAll("/", "-") };
}
export function validateNativeContract(env) {
  if (env.DELIVERY_CLASS === "non-native-fast") return;
  requireValue(
    ["native-proof-required", "cross-platform", "release"].includes(
      env.DELIVERY_CLASS,
    ),
    "unsupported delivery-class",
  );
  requireValue(
    /^sha256:[0-9a-f]{64}$/u.test(env.ENVIRONMENT_ROOT || ""),
    "environment-root must be an exact sha256 content root before required native Warrant admission",
  );
}
export function validateRuntimeSelector(env) {
  requireValue(
    /^(?:v4(?:-alpha)?|[0-9a-f]{40}|train\/v4\/v4\.\d+\/[a-z0-9][a-z0-9._-]*)$/u.test(
      env.BUILDCHAIN_REF || "",
    ),
    "buildchain-ref must be an exact SHA, v4, v4-alpha, or a v4 capability train",
  );
}
