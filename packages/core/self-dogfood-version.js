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

export function resolveSelfDogfoodMajor({
  packageVersion,
  alphaRef,
  majorBootstrap = false,
} = {}) {
  const version = parsePackageVersion(packageVersion);
  const acceptedMajor = parseAlphaRef(alphaRef);
  if (acceptedMajor === version.major) {
    return {
      packageMajor: version.major,
      workflowMajor: acceptedMajor,
      bootstrap: false,
    };
  }

  const stableBootstrap =
    version.minor === 0 && version.patch === 0 && version.alpha === undefined;
  const nextAlphaBootstrap =
    version.minor === 0 && version.patch === 1 && version.alpha !== undefined;
  if (
    majorBootstrap === true &&
    acceptedMajor + 1 === version.major &&
    (stableBootstrap || nextAlphaBootstrap)
  ) {
    return {
      packageMajor: version.major,
      workflowMajor: acceptedMajor,
      bootstrap: true,
    };
  }

  throw new Error(
    "Buildchain self-dogfood alpha lock must target the current major alpha ref",
  );
}

export function contractForSelfDogfoodEvaluation({
  currentContract,
  majorResolution,
} = {}) {
  if (!currentContract || typeof currentContract !== "object") {
    throw new Error("Buildchain self-dogfood requires a current contract");
  }
  if (!majorResolution?.bootstrap) {
    return currentContract;
  }
  return {
    ...currentContract,
    majorLine: `v${majorResolution.workflowMajor}`,
  };
}
