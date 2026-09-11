export function publicationControlPlaneRequest(request) {
  const kind = request.autoAdmissionKind;
  const defaults = {
    "release-candidate": ".github/workflows/public-release-promote.yml",
    "publication-artifact": ".github/workflows/public-release-paper.yml",
    "binary-release-assets": ".github/workflows/.release-binary-assets.yml",
  };
  if (!defaults[kind])
    throw new Error("Unknown publication control-plane audit kind");
  const binary = kind === "binary-release-assets",
    candidate = kind === "release-candidate";
  return {
    repository: request.evidenceRepository,
    workflowRepository: request.runtimeRepository,
    branch: request.targetRef,
    sourceSha: request.sourceSha,
    workflowRef: request.runtimeSha,
    publisherWorkflowPath: request.publisherWorkflowPath,
    requiredStatusCheck: request.requiredStatusCheck || "",
    workflowPath: request.authorityWorkflowPath || defaults[kind],
    jobId: candidate ? "apply" : "publish",
    environment: binary ? "buildchain-release-assets" : "none",
    packageName: binary ? "@kungfu-tech/buildchain" : request.packageName || "",
    publisherMode:
      binary ||
      (candidate && request.publicationTarget.startsWith("github-release:"))
        ? "github-token"
        : "npm-trusted-publisher",
    ...(binary
      ? {
          publicationVersion: request.publicationVersion,
          allowReleaseReconciliation: true,
          environmentRef: `v${request.publicationVersion}`,
          environmentRefType: "tag",
        }
      : {}),
  };
}
