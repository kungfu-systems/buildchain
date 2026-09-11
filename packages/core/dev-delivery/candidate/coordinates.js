import { requireValue } from "../../runtime/action-process.mjs";

export function sourceCoordinates(request) {
  const branch = request.branch || request.defaultBranch || "";
  requireValue(
    /^dev\/v\d+\/v\d+\.\d+$/u.test(branch),
    "target-branch must be a semver dev branch",
  );
  requireValue(
    ["off", "shadow", "required"].includes(request.warrantMode),
    "delivery-warrant-mode must be off, shadow, or required",
  );
  if (request.warrantMode !== "off") {
    requireValue(
      /^[1-9]\d*$/u.test(request.pullRequestNumber || "") &&
        /^[0-9a-f]{40}$/u.test(request.expectedHead || ""),
      "delivery Warrant requires an exact PR number and head",
    );
  }
  requireValue(
    request.warrantMode !== "required" || request.dryRun !== true,
    "required delivery Warrant mode cannot be combined with dry-run",
  );
  return { branch, "branch-artifact": branch.replaceAll("/", "-") };
}
export function validateNativeContract(request) {
  if (request.deliveryClass === "non-native-fast") return;
  requireValue(
    ["native-proof-required", "cross-platform", "release"].includes(
      request.deliveryClass,
    ),
    "unsupported delivery-class",
  );
  requireValue(
    /^sha256:[0-9a-f]{64}$/u.test(request.environmentRoot || ""),
    "environment-root must be an exact sha256 content root before required native Warrant admission",
  );
}
