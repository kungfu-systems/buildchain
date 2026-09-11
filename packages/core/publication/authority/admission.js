import { requireValue } from "../../runtime/action-process.mjs";

export function requireSealedInputs(request) {
  const names = [
    "admissionJson",
    "runnerProvenanceJson",
    "controlPlaneAuditJson",
    "gateAggregateJson",
    "expectedJson",
  ];
  const missing = names.filter((name) => !request[name]);
  requireValue(
    !missing.length,
    `Sealed publication evidence unavailable: missing ${missing.join(",")}. Product publication denied before artifact download; publisher credentials have not been evaluated.`,
  );
}
export function requireManagedInputs(request) {
  requireValue(
    /^[0-9a-f]{40}$/i.test(request.sourceSha),
    "Automatic publication admission requires an exact source SHA",
  );
  requireValue(
    /^(alpha|release)\/v[0-9]+\/v[0-9]+\.[0-9]+$/.test(request.targetRef) ||
      request.targetRef === "publish-gate/major",
    "Automatic publication admission target must be a current managed channel",
  );
  requireValue(
    Boolean(request.publicationVersion),
    "Automatic publication admission requires an exact planned publication version",
  );
  if (request.consumerQualificationRequired === true)
    requireValue(
      Boolean(request.consumerPredicateId) &&
        /^[0-9a-f]{64}$/i.test(request.consumerPredicateDigest),
      "Consumer qualification requires an exact predicate id and SHA-256 command digest",
    );
  if (request.consumerGateControllerSha)
    requireValue(
      /^[0-9a-f]{40}$/i.test(request.consumerGateControllerSha) &&
        Boolean(request.consumerGateCommand),
      "Consumer Gate controller requires an exact commit and command",
    );
  const kind = request.autoAdmissionKind;
  requireValue(
    [
      "release-candidate",
      "publication-artifact",
      "binary-release-assets",
    ].includes(kind),
    `Unsupported automatic admission kind: ${kind}`,
  );
  if (kind === "binary-release-assets") {
    requireValue(
      request.evidenceRepository === "kungfu-systems/buildchain",
      "Binary release evidence must belong to the canonical Buildchain repository",
    );
    requireValue(
      request.publisherWorkflowPath ===
        ".github/workflows/.release-binary-assets.yml",
      "Binary release admission requires the sealed binary publisher workflow",
    );
    requireValue(
      Number(Boolean(request.gateAggregateJson)) +
        Number(request.autoNoGate === true) ===
        1,
      "Binary release admission requires exactly one Gate aggregate or explicit no-Gate decision",
    );
    return;
  }
  requireValue(
    request.evidenceRepository === request.callerRepository,
    "Publication admission evidence must belong to the caller repository",
  );
  requireValue(
    /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(
      request.publisherWorkflowPath,
    ),
    "Publication admission requires a repository-local publisher workflow path",
  );
  if (kind !== "release-candidate") return;
  const target = request.publicationTarget,
    packageName = request.packageName;
  requireValue(
    (Boolean(packageName) && target === `npm:${packageName}`) ||
      (!packageName && target === `github-release:${request.callerRepository}`),
    "Release-candidate admission requires an exact npm or GitHub Release target and matching package name",
  );
  const sources =
    Number(Boolean(request.gateAggregateJson)) +
    Number(request.autoNoGate === true) +
    Number(Boolean(request.consumerGateCommand));
  requireValue(
    sources === 1,
    "Release-candidate admission requires exactly one Gate aggregate, consumer Gate command, or explicit no-Gate decision",
  );
}

export function admitPublicationAuthorityRequest(request) {
  if (request.dryRun) return;
  if (request.autoAdmission) requireManagedInputs(request);
  else requireSealedInputs(request);
}
