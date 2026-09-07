import { nextDevelopmentRoot } from "./next-development-transition.js";

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/u;

export function developmentVersionParts(version) {
  const parts = VERSION.exec(version || "");
  if (!parts) throw new Error("expected a stable or alpha semantic version");
  return parts
    .slice(1)
    .map((part) => (part === undefined ? null : BigInt(part)));
}

export function compareDevelopmentVersions(left, right) {
  const a = developmentVersionParts(left),
    b = developmentVersionParts(right);
  for (let i = 0; i < 4; i += 1) {
    if (a[i] === b[i]) continue;
    if (a[i] === null) return 1;
    if (b[i] === null) return -1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function nextPatchDevelopmentVersion(stableVersion) {
  const [major, minor, patch, alpha] = developmentVersionParts(stableVersion);
  if (alpha !== null)
    throw new Error("completed stable version must not be a prerelease");
  return `${major}.${minor}.${patch + 1n}-alpha.0`;
}

export function createStableDevelopmentTransition({
  repository,
  completedStable,
  model,
  sourcePaths,
  derivedPaths,
}) {
  const value = completedStable || {};
  const version = nextPatchDevelopmentVersion(value.version);
  if (
    !/^[^/\s]+\/[^/\s]+$/u.test(repository || "") ||
    value.outcome !== "succeeded" ||
    value.exactTag !== `v${value.version}` ||
    ![value.releaseSha, value.treeSha].every((sha) =>
      /^[a-f0-9]{40}$/u.test(sha || ""),
    ) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.publicationRoot || "") ||
    !Number.isFinite(Date.parse(value.completedAt))
  )
    throw new Error(
      "stable development requires an exact completed publication",
    );
  if (model.strategy !== "semver" || model.next !== "auto")
    throw new Error("automatic next-patch development requires semver/auto");
  const identity = {
    contract: "buildchain.stable-development-transition/v1",
    repository,
    completedStable: value,
    model,
    sourcePaths,
    derivedPaths,
  };
  return {
    ...identity,
    idempotencyKey: nextDevelopmentRoot(identity),
    target: { version },
    state: { status: "planned" },
    publicationOutcome: "preserved-success",
  };
}
