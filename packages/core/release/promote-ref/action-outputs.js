import * as core from "@actions/core";
export function plannedPublicationExactTag(plannedPublication = {}) {
  return plannedPublication.publicTag || plannedPublication.tag || "";
}
export function reportPromotionResult(result) {
  for (const update of result.updates) {
    const target =
      update.tag ||
      update.ref ||
      (update.version ? `version-state ${update.version}` : "promotion");
    const detail = update.files?.length ? ` (${update.files.join(", ")})` : "";
    const reason = update.reason ? `: ${update.reason}` : "";
    console.log(
      `${update.action}: ${target} -> ${update.sha}${detail}${reason}`,
    );
  }
  core.setOutput("sha", result.sha);
  core.setOutput(
    "next-anchor-required",
    String(result.nextAlphaRequired === true),
  );
  core.setOutput("transaction-id", result.publishTransaction?.id || "");
  core.setOutput("transaction-state", result.publishTransaction?.state || "");
  core.setOutput(
    "transaction-publication-state",
    result.publishTransaction?.publicationState || "",
  );
  core.setOutput(
    "transaction-sealed-bundle-root",
    result.publishTransaction?.sealedBundleRoot || "",
  );
  core.setOutput(
    "transaction-resume-command",
    result.publishTransaction?.resumeCommand || "",
  );
  core.setOutput(
    "transaction-exact-tag",
    result.publishTransaction?.exactTag || "",
  );
  const plannedPublication = result.updates.find(
    (update) => update.action === "dry-run-publish-transaction",
  );
  core.setOutput(
    "planned-publication-version",
    plannedPublication?.version || "",
  );
  core.setOutput(
    "planned-publication-exact-tag",
    plannedPublicationExactTag(plannedPublication),
  );
  core.setOutput(
    "planned-release-candidate-version",
    plannedPublication?.releaseCandidateVersion || "",
  );
  core.setOutput(
    "public-release-tag",
    result.publishTransaction?.publicReleaseTag ||
      result.publishTransaction?.exactTag ||
      "",
  );
  core.setOutput(
    "transaction-release-sha",
    result.publishTransaction?.releaseSha || "",
  );
  core.setOutput(
    "transaction-state-ref",
    result.publishTransaction?.stateRef || "",
  );
  core.setOutput(
    "transaction-state-sha",
    result.publishTransaction?.stateSha || "",
  );
  core.setOutput(
    "transaction-state-path",
    result.publishTransaction?.statePath || "",
  );
  core.setOutput(
    "publish-evidence-path",
    result.publishTransaction?.evidencePath || "",
  );
  core.setOutput(
    "release-passport-path",
    result.publishTransaction?.releasePassportPath || "",
  );
  core.setOutput(
    "release-passport-output-dir",
    result.publishTransaction?.releasePassportOutputDir || "",
  );
  core.setOutput(
    "release-passport-state-sha",
    result.publishTransaction?.releasePassportStateSha || "",
  );
  core.setOutput(
    "finalization-needed",
    String(result.publishTransaction?.finalizationNeeded === true),
  );
}
export function reportReleaseTailResult(githubReleaseResult, result) {
  core.setOutput("github-release-url", githubReleaseResult?.url || "");
  core.setOutput("github-release-action", githubReleaseResult?.action || "");
  core.setOutput(
    "release-tail-declaration-path",
    githubReleaseResult?.declarationPath || "",
  );
  core.setOutput(
    "release-tail-declaration-root",
    githubReleaseResult?.declarationRoot || "",
  );
  core.setOutput(
    "release-tail-transaction-state",
    githubReleaseResult?.transaction?.state || "",
  );
  core.setOutput(
    "release-tail-transaction-root",
    githubReleaseResult?.transaction?.transactionRoot || "",
  );
  core.setOutput(
    "release-tail-state-path",
    githubReleaseResult?.statePath || "",
  );
  core.setOutput(
    "release-tail-state-root",
    githubReleaseResult?.transaction?.stateRoot || "",
  );
  core.setOutput(
    "release-tail-receipt-roots-json",
    JSON.stringify(
      (githubReleaseResult?.transaction?.receipts || []).map(
        (receipt) => receipt.receiptRoot,
      ),
    ),
  );
  core.setOutput(
    "tags",
    result.updates
      .map((update) => update.tag)
      .filter(Boolean)
      .join(","),
  );
}
