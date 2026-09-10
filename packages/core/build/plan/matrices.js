export function buildMatrices(plan, resolved) {
  const platforms = JSON.parse(resolved.platformsJson);
  const credential = plan.build.macos_signing;
  if (
    credential.app_path &&
    !platforms.some(
      (p) => p.id === credential.platform && p.platform === "macos",
    )
  )
    throw new Error("macOS signing platform is not a declared macOS lane");
  if (credential.app_path && !plan.environment.signing.environment)
    throw new Error("macOS signing requires a governed credential environment");
  if (
    plan.build.finalization.on_platform &&
    platforms.some((p) => !p.githubHosted)
  )
    throw new Error("Platform finalization requires GitHub-hosted runners");
  if (
    plan.build.attestation.subject_path &&
    !platforms.some((p) => p.id === plan.build.attestation.platform)
  )
    throw new Error("Attestation platform is not declared");
  const annotate = (p) => ({
    ...p,
    runner:
      p.provider === "aws-codebuild"
        ? [`codebuild-${p.project}-${plan.run.id}-${plan.run.attempt}`]
        : JSON.parse(p.runner),
  });
  return {
    platforms: platforms.map(annotate),
    matrix: {
      native: JSON.parse(resolved.nativePlatformsJson).map(annotate),
      container: JSON.parse(resolved.containerPlatformsJson).map(annotate),
      sign: [
        ...platforms.map((p) => ({
          id: p.id,
          kind: "artifact",
          runner: plan.build.finalization.on_platform
            ? JSON.parse(p.runner)
            : ["ubuntu-24.04"],
          environment: "",
        })),
        ...(credential.app_path
          ? [
              {
                id: credential.platform,
                kind: "credential",
                runner: ["macos-15"],
                environment: plan.environment.signing.environment,
              },
            ]
          : []),
      ],
    },
    container: resolved.linuxContainer,
  };
}
