import { adopterDeliveryGateDigest } from "./adopter-delivery-gate.js";
import { withPublishedBuildchainDeliveryAuthority } from "./published-delivery-authority.js";

export const BUILDCHAIN_DELIVERY_SELF_DOGFOOD_CONTRACT =
  "kungfu-buildchain-delivery-infrastructure-self-dogfood/v1";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BUILDCHAIN_PACKAGE = "@kungfu-tech/buildchain";
const KFD_PACKAGE = "@kungfu-tech/kfd";

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
