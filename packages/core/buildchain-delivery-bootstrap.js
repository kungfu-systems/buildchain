import { adopterDeliveryGateDigest } from "./adopter-delivery-gate.js";
import { validateAdopterDeliveryGateResult } from "./adopter-delivery-passport.js";

export const BUILDCHAIN_DELIVERY_BOOTSTRAP_CONTRACT =
  "kungfu-buildchain-delivery-infrastructure-bootstrap/v1";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function issue(code, message) {
  return { code, message };
}

function exactRoot(value) {
  return ROOT_PATTERN.test(value ?? "");
}

function exactCut(cut) {
  return (
    cut &&
    typeof cut === "object" &&
    typeof cut.version === "string" &&
    SHA_PATTERN.test(cut.sourceCommit ?? "") &&
    exactRoot(cut.packageRoot) &&
    exactRoot(cut.gateRoot) &&
    typeof cut.protocol?.id === "string" &&
    typeof cut.protocol?.version === "string" &&
    exactRoot(cut.protocol?.root) &&
    typeof cut.profile?.id === "string" &&
    typeof cut.profile?.version === "string" &&
    exactRoot(cut.profile?.root)
  );
}

function parseSemver(value) {
  const match = SEMVER_PATTERN.exec(value ?? "");
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(left, right) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) {
    return Math.sign(leftNumber - rightNumber);
  }
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return Math.sign(left.core[index] - right.core[index]);
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const width = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < width; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifier(
      left.prerelease[index],
      right.prerelease[index],
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function sameProtocol(left, right) {
  return (
    left?.id === right?.id &&
    left?.version === right?.version &&
    left?.root === right?.root
  );
}

function validTransition(transition, authority, candidate) {
  if (!transition || typeof transition !== "object") return false;
  const body = structuredClone(transition);
  const transitionRoot = body.transitionRoot;
  delete body.transitionRoot;
  return (
    exactRoot(transitionRoot) &&
    adopterDeliveryGateDigest(body) === transitionRoot &&
    body.fromGateRoot === authority.gateRoot &&
    body.toGateRoot === candidate.gateRoot &&
    body.fromProtocolRoot === authority.protocol.root &&
    body.toProtocolRoot === candidate.protocol.root &&
    body.fromProfileRoot === authority.profile.root &&
    body.toProfileRoot === candidate.profile.root &&
    exactRoot(body.compatibilityProofRoot) &&
    exactRoot(body.independentReviewRoot)
  );
}

function validateWarrant(warrant, candidate) {
  return (
    warrant &&
    typeof warrant === "object" &&
    warrant.outcome === "merged" &&
    warrant.sourceHead === candidate.sourceCommit &&
    exactRoot(warrant.sourceProofRoot) &&
    exactRoot(warrant.nativeProofRoot) &&
    exactRoot(warrant.integrationProofRoot)
  );
}

export function qualifyBuildchainDeliveryInfrastructureBootstrap({
  authority,
  candidate,
  gateResult,
  warrant,
  transitionEvidence,
} = {}) {
  const issues = [];
  if (!exactCut(authority)) {
    issues.push(
      issue("bootstrap.authority.cut", "N-1 authority cut is incomplete"),
    );
  }
  if (!exactCut(candidate)) {
    issues.push(
      issue("bootstrap.candidate.cut", "candidate cut is incomplete"),
    );
  }
  if (authority?.protected !== true || authority?.published !== true) {
    issues.push(
      issue(
        "bootstrap.authority.release",
        "N-1 authority must be both protected and publicly released",
      ),
    );
  }
  if (candidate?.authorityVersion !== authority?.version) {
    issues.push(
      issue(
        "bootstrap.authority.stale",
        "candidate must name the exact N-1 authority version",
      ),
    );
  }
  const versionOrder = compareSemver(authority?.version, candidate?.version);
  if (versionOrder === null || versionOrder >= 0) {
    issues.push(
      issue(
        "bootstrap.authority.order",
        "N-1 authority version must precede the candidate version",
      ),
    );
  }
  if (
    authority?.sourceCommit === candidate?.sourceCommit ||
    authority?.packageRoot === candidate?.packageRoot
  ) {
    issues.push(
      issue(
        "bootstrap.self-authorization",
        "candidate source or package cannot serve as its own N-1 authority",
      ),
    );
  }

  const gateValidation = validateAdopterDeliveryGateResult(gateResult);
  if (!gateValidation.passed) {
    issues.push(
      issue(
        "bootstrap.gate.failed",
        "candidate must retain a passed public adopter delivery gate result",
      ),
    );
  }
  if (
    gateResult?.artifact?.root !== candidate?.packageRoot ||
    gateResult?.project?.adopterId !== "kungfu-systems/buildchain"
  ) {
    issues.push(
      issue(
        "bootstrap.gate.candidate",
        "gate result must bind the exact Buildchain candidate package",
      ),
    );
  }
  if (!validateWarrant(warrant, candidate)) {
    issues.push(
      issue(
        "bootstrap.warrant",
        "merged Delivery Warrant evidence must bind the candidate source",
      ),
    );
  }

  const transitionRequired =
    !sameProtocol(authority?.protocol, candidate?.protocol) ||
    !sameProtocol(authority?.profile, candidate?.profile) ||
    authority?.gateRoot !== candidate?.gateRoot;
  if (
    transitionRequired &&
    !validTransition(transitionEvidence, authority, candidate)
  ) {
    issues.push(
      issue(
        "bootstrap.transition",
        "gate, protocol, or profile changes require exact independent transition evidence",
      ),
    );
  }

  const result = {
    schemaVersion: 1,
    contract: BUILDCHAIN_DELIVERY_BOOTSTRAP_CONTRACT,
    status: issues.length === 0 ? "passed" : "failed",
    authority: structuredClone(authority ?? null),
    candidate: structuredClone(candidate ?? null),
    gateResultRoot: gateResult?.gateRoot ?? null,
    warrant: structuredClone(warrant ?? null),
    transitionRequired,
    transitionEvidenceRoot: transitionEvidence?.transitionRoot ?? null,
    issues,
    qualifying: false,
    selfCertified: false,
    releaseAuthorized: false,
    finalAuthority: "protected-n-minus-one-plus-exact-delivery-evidence",
  };
  result.bootstrapRoot = adopterDeliveryGateDigest(result);
  return result;
}
