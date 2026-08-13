function parsePackageVersion(version) {
  const match = String(version || "").match(
    /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/,
  );
  if (!match) {
    throw new Error(
      "root package version must expose a numeric semver version for self-dogfood",
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    alpha: match[4] === undefined ? undefined : Number(match[4]),
  };
}

function parseAlphaRef(ref) {
  const match = String(ref || "").match(/^v(\d+)-alpha$/);
  if (!match) {
    throw new Error(
      "Buildchain self-dogfood alpha lock must target a major alpha ref",
    );
  }
  return Number(match[1]);
}

function isExactSha(value) {
  return /^[0-9a-f]{40}$/u.test(String(value || ""));
}

export function hasQualifiedSelfDogfoodBootstrapAuthority({
  packageVersion,
  alphaRef,
  authority,
} = {}) {
  const version = parsePackageVersion(packageVersion);
  const acceptedMajor = parseAlphaRef(alphaRef);
  const releaseLine = authority?.releaseLine;
  const qualification = authority?.qualification;
  return (
    acceptedMajor + 1 === version.major &&
    authority?.contract ===
      `kungfu-buildchain-v${version.major}-bootstrap-authority` &&
    releaseLine?.candidateBranch ===
      `dev/v${version.major}/v${version.major}.0` &&
    String(releaseLine?.sourceBranch || "").startsWith(
      `dev/v${acceptedMajor}/v${acceptedMajor}.`,
    ) &&
    releaseLine?.status === `qualified-protected-v${version.major}-bootstrap` &&
    isExactSha(releaseLine?.sourceCommit) &&
    isExactSha(releaseLine?.bootstrapCommit) &&
    qualification?.contract ===
      `kungfu-buildchain-v${version.major}-n-minus-one-qualification` &&
    qualification?.authorityRevision === releaseLine.sourceCommit &&
    qualification?.candidateRevision === releaseLine.bootstrapCommit &&
    qualification?.candidateSelfQualified === false &&
    qualification?.activeExceptions === 0 &&
    /^sha256:[0-9a-f]{64}$/u.test(
      String(qualification?.qualificationRoot || ""),
    )
  );
}

export function resolveSelfDogfoodMajor({
  packageVersion,
  alphaRef,
} = {}) {
  const version = parsePackageVersion(packageVersion);
  const acceptedMajor = parseAlphaRef(alphaRef);
  if (acceptedMajor !== version.major) {
    throw new Error(
      "Buildchain self-dogfood alpha lock must target the current major alpha ref",
    );
  }
  return {
    packageMajor: version.major,
    workflowMajor: acceptedMajor,
    bootstrap: false,
  };
}

export function contractForSelfDogfoodEvaluation({
  currentContract,
  majorResolution,
} = {}) {
  if (!currentContract || typeof currentContract !== "object") {
    throw new Error("Buildchain self-dogfood requires a current contract");
  }
  return currentContract;
}

export function canAdmitSelfDogfoodLockEvaluation({
  evaluation,
  majorResolution,
} = {}) {
  return evaluation?.compatible === true;
}
