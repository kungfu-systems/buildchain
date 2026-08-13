import { initAdopterManifest } from "@kungfu-tech/kfd/adopter-conformance/toolchain";

import { adopterDeliveryGateDigest } from "./adopter-delivery-gate.js";
import { withPublishedBuildchainDeliveryAuthority } from "./published-delivery-authority.js";

export const BUILDCHAIN_DELIVERY_SELF_DOGFOOD_CONTRACT =
  "kungfu-buildchain-delivery-infrastructure-self-dogfood/v1";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const BUILDCHAIN_PACKAGE = "@kungfu-tech/buildchain";
const KFD_PACKAGE = "@kungfu-tech/kfd";
const PROFILE_REQUIREMENTS = Object.freeze([
  ["adopter-identity", ["declaration"]],
  ["artifact-readback", ["verification"]],
  ["claim-boundary", ["declaration"]],
  ["delivery-policy-cut", ["declaration", "verification"]],
  ["kfd-cut", ["verification"]],
  ["protected-delivery", ["implementation", "review", "verification"]],
  ["source-artifact", ["implementation"]],
]);

function exactPackage(value, { name, version = "", root = "", label }) {
  if (
    value?.name !== name ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    !ROOT_PATTERN.test(value.artifactRoot ?? "")
  ) {
    throw new TypeError(`${label} package identity is incomplete`);
  }
  if (version && value.version !== version) {
    throw new TypeError(`${label} package version does not match its binding`);
  }
  if (root && value.artifactRoot !== root) {
    throw new TypeError(`${label} package root does not match its binding`);
  }
  return structuredClone(value);
}

function authorityFunctions(authorityRuntime) {
  const names = [
    "createBuildchainDeliveryInfrastructureInstanceManifest",
    "verifyBuildchainDeliveryInfrastructureInstance",
    "createAdopterDeliveryGate",
    "createPackageArtifactProfile",
    "createKfdAdopterCategoryProtocolDriver",
    "qualifyBuildchainDeliveryInfrastructureBootstrap",
  ];
  for (const name of names) {
    if (typeof authorityRuntime?.[name] !== "function") {
      throw new TypeError(`authority runtime is missing ${name}`);
    }
  }
  return authorityRuntime;
}

function passed(value, label) {
  if (value?.status !== "passed") {
    throw new Error(
      `${label} failed closed: ${JSON.stringify(value?.issues ?? [])}`,
    );
  }
  return value;
}

function candidateWarrant(candidate) {
  const terminal = candidate?.terminal;
  if (
    candidate?.status !== "merged" ||
    !SHA_PATTERN.test(candidate?.sourceHead ?? "") ||
    !ROOT_PATTERN.test(candidate?.sourceProofRoot ?? "") ||
    terminal?.outcome !== "merged" ||
    !ROOT_PATTERN.test(terminal?.nativeProofRoot ?? "") ||
    !ROOT_PATTERN.test(terminal?.evidenceRoot ?? "")
  ) {
    throw new TypeError("candidate Warrant settlement is incomplete");
  }
  return {
    outcome: "merged",
    sourceHead: candidate.sourceHead,
    sourceProofRoot: candidate.sourceProofRoot,
    nativeProofRoot: terminal.nativeProofRoot,
    integrationProofRoot: terminal.evidenceRoot,
  };
}

function deliveryCut() {
  const protocol = {
    id: "kfd.adopter-category/instance-manifest",
    version: "1.0.0",
  };
  protocol.root = adopterDeliveryGateDigest(protocol);
  const profile = {
    id: "kfd.adopter-category/delivery-infrastructure",
    version: "1.0.0",
  };
  profile.root = adopterDeliveryGateDigest({
    ...profile,
    requirements: PROFILE_REQUIREMENTS,
  });
  return {
    gateRoot: adopterDeliveryGateDigest({
      protocol,
      profile,
      artifactProfile: {
        id: "buildchain.artifact/package",
        version: "1.0.0",
      },
    }),
    protocol,
    profile,
  };
}

function candidateEvidence({
  source,
  artifact,
  authority,
  warrant,
  kfdRoot,
  observedAt,
}) {
  const roots = {
    "adopter-identity:declaration": source.root,
    "artifact-readback:verification": artifact.root,
    "claim-boundary:declaration": adopterDeliveryGateDigest({
      qualifying: false,
      selfCertified: false,
      releaseAuthorized: false,
    }),
    "delivery-policy-cut:declaration": authority.gateRoot,
    "delivery-policy-cut:verification": warrant.integrationProofRoot,
    "kfd-cut:verification": kfdRoot,
    "protected-delivery:implementation": artifact.root,
    "protected-delivery:review": warrant.sourceProofRoot,
    "protected-delivery:verification": warrant.nativeProofRoot,
    "source-artifact:implementation": source.root,
  };
  return PROFILE_REQUIREMENTS.flatMap(([requirementId, kinds]) =>
    kinds.map((kind) => ({
      requirementId,
      kind,
      coordinate: `evidence://kungfu-systems/buildchain/${requirementId}/${kind}`,
      root: roots[`${requirementId}:${kind}`],
      observedAt,
    })),
  );
}

export function createBuildchainDeliveryInfrastructureSelfDogfood(
  {
    authorityPackage,
    kfdPackage,
    authority,
    candidate,
    instanceId,
    adopterManifest,
    source,
    artifact,
    release,
    evidence = [],
    warrant,
    transitionEvidence,
    verifiedAt,
    maxAgeSeconds,
  } = {},
  authorityRuntime,
) {
  const runtime = authorityFunctions(authorityRuntime);
  const boundAuthorityPackage = exactPackage(authorityPackage, {
    name: BUILDCHAIN_PACKAGE,
    version: authority?.version,
    root: authority?.packageRoot,
    label: "Buildchain authority",
  });
  const boundKfdPackage = exactPackage(kfdPackage, {
    name: KFD_PACKAGE,
    version: adopterManifest?.kfdCut?.package?.version,
    root: adopterManifest?.kfdCut?.package?.artifactRoot,
    label: "KFD authority",
  });
  if (candidate?.authorityVersion !== boundAuthorityPackage.version) {
    throw new TypeError(
      "candidate does not name the exact Buildchain N-1 authority",
    );
  }

  const instanceManifest =
    runtime.createBuildchainDeliveryInfrastructureInstanceManifest({
      instanceId,
      adopterManifest,
      source,
      artifact,
      release,
      evidence,
    });
  const instanceReport = runtime.verifyBuildchainDeliveryInfrastructureInstance(
    instanceManifest,
    {
      adopterManifest,
      verifiedAt,
      maxAgeSeconds,
    },
  );
  if (instanceReport?.valid !== true) {
    throw new Error(
      `delivery-infrastructure instance failed closed: ${JSON.stringify(instanceReport?.issues ?? [])}`,
    );
  }

  const gateResult = passed(
    runtime
      .createAdopterDeliveryGate({
        drivers: [runtime.createKfdAdopterCategoryProtocolDriver()],
        artifactProfiles: [runtime.createPackageArtifactProfile()],
      })
      .evaluate(
        {
          schemaVersion: 1,
          contract: "kungfu-buildchain-adopter-delivery-request",
          protocol: {
            id: "kfd.adopter-category/instance-manifest",
            version: "1.0.0",
          },
          artifactProfile: {
            id: "buildchain.artifact/package",
            version: "1.0.0",
          },
          project: {
            instanceId,
            adopterId: "kungfu-systems/buildchain",
          },
          artifact: structuredClone(artifact),
          declaration: instanceManifest,
        },
        { adopterManifest, verifiedAt, maxAgeSeconds },
      ),
    "adopter delivery gate",
  );
  const bootstrap = passed(
    runtime.qualifyBuildchainDeliveryInfrastructureBootstrap({
      authority,
      candidate,
      gateResult,
      warrant,
      transitionEvidence,
    }),
    "delivery-infrastructure bootstrap",
  );

  const result = {
    schemaVersion: 1,
    contract: BUILDCHAIN_DELIVERY_SELF_DOGFOOD_CONTRACT,
    status: "passed",
    authorityRuntime: {
      buildchainPackage: boundAuthorityPackage,
      kfdPackage: boundKfdPackage,
    },
    candidate: structuredClone(candidate),
    roots: {
      adopterManifest: adopterDeliveryGateDigest(adopterManifest),
      instanceManifest: adopterDeliveryGateDigest(instanceManifest),
      instanceReport: adopterDeliveryGateDigest(instanceReport),
      gateResult: gateResult.gateRoot,
      bootstrap: bootstrap.bootstrapRoot,
      warrant: adopterDeliveryGateDigest(warrant),
    },
    instanceManifest,
    instanceReport,
    gateResult,
    bootstrap,
    qualifying: false,
    selfCertified: false,
    releaseAuthorized: false,
    finalAuthority:
      "protected-n-minus-one-runtime-plus-exact-delivery-evidence",
  };
  result.selfDogfoodRoot = adopterDeliveryGateDigest(result);
  return result;
}

export async function createPublishedBuildchainDeliveryInfrastructureSelfDogfood({
  authorityPackages,
  selfDogfood,
} = {}) {
  return withPublishedBuildchainDeliveryAuthority(
    authorityPackages,
    async ({ packages, authorityRuntime, authorityRoot }) => {
      const result = createBuildchainDeliveryInfrastructureSelfDogfood(
        {
          ...structuredClone(selfDogfood ?? {}),
          authorityPackage: packages.buildchain,
          kfdPackage: packages.kfd,
        },
        authorityRuntime,
      );
      return {
        ...result,
        publishedAuthorityRoot: authorityRoot,
      };
    },
  );
}

export async function createPublishedBuildchainDeliveryInfrastructureCandidateSelfDogfood({
  authorityPackages,
  authoritySourceCommit,
  candidatePackage,
  warrantCandidate,
  source,
  release,
  verifiedAt,
  maxAgeSeconds = 86400,
} = {}) {
  if (!SHA_PATTERN.test(authoritySourceCommit ?? "")) {
    throw new TypeError("authority source commit is invalid");
  }
  const artifact = exactPackage(candidatePackage, {
    name: BUILDCHAIN_PACKAGE,
    label: "Buildchain candidate",
  });
  if (
    source?.coordinate !==
      `kungfu-systems/buildchain@${warrantCandidate?.sourceHead ?? ""}` ||
    !ROOT_PATTERN.test(source?.root ?? "") ||
    !ROOT_PATTERN.test(release?.root ?? "")
  ) {
    throw new TypeError("candidate source or release binding is incomplete");
  }
  const warrant = candidateWarrant(warrantCandidate);
  const cut = deliveryCut();
  const authority = {
    version: authorityPackages?.buildchain?.version,
    sourceCommit: authoritySourceCommit,
    packageRoot: authorityPackages?.buildchain?.artifactRoot,
    ...cut,
    protected: true,
    published: true,
  };
  const candidate = {
    version: artifact.version,
    sourceCommit: warrant.sourceHead,
    packageRoot: artifact.artifactRoot,
    ...cut,
    authorityVersion: authority.version,
  };
  const adopterManifest = initAdopterManifest({
    manifestId: `buildchain-delivery-infrastructure-${artifact.version}`,
    adopterId: "kungfu-systems/buildchain",
    artifactKind: "package",
    artifactCoordinate: `${artifact.name}@${artifact.version}`,
    artifactRoot: artifact.artifactRoot,
    scope: "Buildchain delivery infrastructure release candidate self-dogfood",
    packageArtifactRoot: authorityPackages?.kfd?.artifactRoot,
    verifiedAt,
    maxAgeSeconds,
  });
  adopterManifest.releaseBindings.push({
    id: `buildchain-${artifact.version}`,
    artifact: {
      kind: "package",
      coordinate: `${artifact.name}@${artifact.version}`,
      root: artifact.artifactRoot,
    },
    releasePassport: structuredClone(release),
    kfdPackageRoot: authorityPackages.kfd.artifactRoot,
  });
  const evidence = candidateEvidence({
    source,
    artifact: adopterManifest.releaseBindings[0].artifact,
    authority,
    warrant,
    kfdRoot: authorityPackages.kfd.artifactRoot,
    observedAt: verifiedAt,
  });
  const result =
    await createPublishedBuildchainDeliveryInfrastructureSelfDogfood({
      authorityPackages,
      selfDogfood: {
        authority,
        candidate,
        instanceId: `kungfu-systems/buildchain@${artifact.version}`,
        adopterManifest,
        source,
        artifact: adopterManifest.releaseBindings[0].artifact,
        release,
        evidence,
        warrant,
        verifiedAt,
        maxAgeSeconds,
      },
    });
  return { ...result, adopterManifest, deliveryEvidence: evidence };
}
