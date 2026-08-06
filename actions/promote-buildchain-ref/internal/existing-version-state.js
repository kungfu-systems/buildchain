function resolveExistingVersionState({
  changedFiles,
  recoveredCandidate,
  version,
  dryRun,
  workspaceCwd,
  verificationCommand,
  discovered,
  discoveredPaths,
  versionStateAllowedPaths,
  strategyEnv,
  baseSha,
  publishVersion,
  hasVersionVerification,
  versionStrategy,
  anchorManifest,
  updates,
  runVersionVerification,
  createVerifiedVersionStateCommit,
}) {
  if (changedFiles.length !== 0) return undefined;
  if (recoveredCandidate) {
    console.log(
      `> recovered candidate version state for ${version}: existing; skipped lifecycle verification`,
    );
    updates.push({
      version,
      action: "existing-recovered-version-state",
      packageManager: discovered.packageManager.name,
      files: discoveredPaths,
      sha: baseSha,
      publishVersion,
    });
    return {
      sha: baseSha,
      version,
      action: "existing",
      publishVersion,
      files: discoveredPaths,
      releaseTreeAllowedPaths: versionStateAllowedPaths,
      hasVersionVerification,
      packageManager: discovered.packageManager,
      versionStrategy,
      anchorManifest,
    };
  }
  const verifiedChangedFiles = runVersionVerification({
    cwd: workspaceCwd,
    command: verificationCommand,
    loadedConfig: discovered.config,
    version,
    changedFiles: [],
    allowedPaths: versionStateAllowedPaths,
    env: strategyEnv,
    runLifecycleVerify: !dryRun,
  });
  if (verifiedChangedFiles.length > 0) {
    console.log(
      `> version state lifecycle changes for ${version}: ${verifiedChangedFiles.map((file) => file.path).join(", ")}`,
    );
    if (!dryRun) return createVerifiedVersionStateCommit(verifiedChangedFiles);
    updates.push({
      version,
      action: "dry-run-version-state",
      packageManager: discovered.packageManager.name,
      files: verifiedChangedFiles.map((file) => file.path),
      sha: baseSha,
    });
    return {
      sha: baseSha,
      version,
      action: "dry-run",
      publishVersion,
      files: verifiedChangedFiles.map((file) => file.path),
      releaseTreeAllowedPaths: verifiedChangedFiles.map((file) => file.path),
      hasVersionVerification,
      packageManager: discovered.packageManager,
      versionStrategy,
      anchorManifest,
    };
  }
  updates.push({
    version,
    action: "existing-version-state",
    packageManager: discovered.packageManager.name,
    files: discoveredPaths,
    sha: baseSha,
    publishVersion,
  });
  return {
    sha: baseSha,
    version,
    action: "existing",
    publishVersion,
    files: discoveredPaths,
    releaseTreeAllowedPaths: versionStateAllowedPaths,
    hasVersionVerification,
    packageManager: discovered.packageManager,
    versionStrategy,
    anchorManifest,
  };
}

export { resolveExistingVersionState };
