import { parseJsonInput, parseJsonInputWithMeta } from "./inputs.js";
import { normalizeAnchorManifest } from "./documents.js";
import { parseJsonCommandOutput } from "./commands.js";
import { createInvariantPassportGate } from "./invariants.js";
import { parseConsumerPolicyCertification } from "./consumer-input.js";
import { normalizeGitHubArtifactAttestationPolicy } from "../../build/github-artifact-attestation.js";
export function collectPublicationInputs({
  anchorManifestJson,
  assetsJson,
  cwd,
  impactJson,
  packageSetJson,
  publishEvidenceJson,
  releaseJson,
  releaseJsonExtra,
  transactionJson,
  trustedPublishingJson,
  versionMaterialJson,
}) {
  const release = parseJsonInput(
    releaseJson,
    {},
    { cwd, label: "releaseJson" },
  );
  const releaseExtra = parseJsonInput(
    releaseJsonExtra,
    {},
    { cwd, label: "releaseJsonExtra" },
  );
  const assetsFromJson = parseJsonInput(assetsJson, [], {
    cwd,
    label: "assetsJson",
  });
  const packageSet = parseJsonInput(packageSetJson, undefined, {
    cwd,
    label: "packageSetJson",
  });
  const publishEvidenceMeta = parseJsonInputWithMeta(
    publishEvidenceJson,
    undefined,
    { cwd, label: "publishEvidenceJson" },
  );
  const trustedPublishing = parseJsonInput(trustedPublishingJson, undefined, {
    cwd,
    label: "trustedPublishingJson",
  });
  const transactionMeta = parseJsonInputWithMeta(transactionJson, undefined, {
    cwd,
    label: "transactionJson",
  });
  const anchorManifest = normalizeAnchorManifest(
    parseJsonInputWithMeta(anchorManifestJson, undefined, {
      cwd,
      label: "anchorManifestJson",
    }),
  );
  const versionMaterial = parseJsonInput(versionMaterialJson, undefined, {
    cwd,
    label: "versionMaterialJson",
  });
  const impactMeta = parseJsonInputWithMeta(impactJson, undefined, {
    cwd,
    label: "impactJson",
  });
  return {
    anchorManifest,
    assetsFromJson,
    impactMeta,
    packageSet,
    publishEvidenceMeta,
    release,
    releaseExtra,
    transactionMeta,
    trustedPublishing,
    versionMaterial,
  };
}
export function collectBuildInputs({
  buildFactsJsons,
  buildSummaryJson,
  cwd,
  distTagEvidenceJson,
  platformManifestJsons,
}) {
  const buildSummaryMeta = parseJsonInputWithMeta(buildSummaryJson, undefined, {
    cwd,
    label: "buildSummaryJson",
  });
  const buildFactMetas = (buildFactsJsons || [])
    .filter(Boolean)
    .map((buildFactsJson) =>
      parseJsonInputWithMeta(buildFactsJson, undefined, {
        cwd,
        label: "buildFactsJsons entry",
      }),
    )
    .filter((meta) => meta.value);
  const platformManifestMetas = (platformManifestJsons || [])
    .filter(Boolean)
    .map((manifestJson) =>
      parseJsonInputWithMeta(manifestJson, undefined, {
        cwd,
        label: "platformManifestJsons entry",
      }),
    );
  const distTagEvidenceMeta = parseJsonInputWithMeta(
    distTagEvidenceJson,
    undefined,
    { cwd, label: "distTagEvidenceJson" },
  );
  return {
    buildFactMetas,
    buildSummaryMeta,
    distTagEvidenceMeta,
    platformManifestMetas,
  };
}
export function collectTrustInputs({
  basePassportJson,
  cwd,
  invariantPassportCommand,
  invariantPassportJsons,
  kfd1WitnessJsons,
  kfd2ClaimJsons,
  kfd3ArtifactVerifyCommand,
  kfd3ArtifactWitnessJsons,
  kfd3PrebuildWitnessJsons,
  releaseEvidenceJsons,
}) {
  const kfd1WitnessMetas = (kfd1WitnessJsons || [])
    .filter(Boolean)
    .map((witnessJson) =>
      parseJsonInputWithMeta(witnessJson, undefined, {
        cwd,
        label: "kfd1WitnessJsons entry",
      }),
    )
    .filter((meta) => meta.value);
  const kfd2ClaimMetas = (kfd2ClaimJsons || [])
    .filter(Boolean)
    .map((claimJson) =>
      parseJsonInputWithMeta(claimJson, undefined, {
        cwd,
        label: "kfd2ClaimJsons entry",
      }),
    )
    .filter((meta) => meta.value);
  const kfd3PrebuildWitnessMetas = (kfd3PrebuildWitnessJsons || [])
    .filter(Boolean)
    .map((witnessJson) =>
      parseJsonInputWithMeta(witnessJson, undefined, {
        cwd,
        label: "kfd3PrebuildWitnessJsons entry",
      }),
    )
    .filter((meta) => meta.value);
  const kfd3ArtifactWitnessMetas = (kfd3ArtifactWitnessJsons || [])
    .filter(Boolean)
    .map((witnessJson) =>
      parseJsonInputWithMeta(witnessJson, undefined, {
        cwd,
        label: "kfd3ArtifactWitnessJsons entry",
      }),
    )
    .filter((meta) => meta.value);
  const basePassportMeta = parseJsonInputWithMeta(basePassportJson, undefined, {
    cwd,
    label: "basePassportJson",
  });
  const kfd3ArtifactCommandMeta = parseJsonCommandOutput({
    command: kfd3ArtifactVerifyCommand,
    cwd,
    label: "KFD-3 artifact verify command",
  });
  const invariantPassportMetas = (invariantPassportJsons || [])
    .filter(Boolean)
    .map((passportJson) =>
      parseJsonInputWithMeta(passportJson, undefined, {
        cwd,
        label: "invariantPassportJsons entry",
      }),
    )
    .filter((meta) => meta.value);
  const invariantPassportCommandMeta = parseJsonCommandOutput({
    command: invariantPassportCommand,
    cwd,
    label: "invariant passport command",
  });
  if (invariantPassportCommandMeta.value)
    invariantPassportMetas.push(invariantPassportCommandMeta);
  const invariantPassports = createInvariantPassportGate(
    invariantPassportMetas,
  );
  const releaseEvidenceMetas = (releaseEvidenceJsons || [])
    .filter(Boolean)
    .map((evidenceJson) =>
      parseJsonInputWithMeta(evidenceJson, undefined, {
        cwd,
        label: "releaseEvidenceJsons entry",
      }),
    )
    .filter((meta) => meta.value);
  return {
    basePassportMeta,
    invariantPassports,
    kfd1WitnessMetas,
    kfd2ClaimMetas,
    kfd3ArtifactCommandMeta,
    kfd3ArtifactWitnessMetas,
    kfd3PrebuildWitnessMetas,
    releaseEvidenceMetas,
  };
}
export function collectControllerInputs({
  cwd,
  domainConsumerPolicyCertificationJson,
  domainRuntimeResumeEvidenceJson,
  githubArtifactAttestationPolicyJsons,
  kfdAgentHubEvidenceJson,
}) {
  const consumerPolicyCertificationMeta = parseConsumerPolicyCertification(
    domainConsumerPolicyCertificationJson,
    cwd,
  );
  const domainRuntimeResumeEvidence = parseJsonInput(
    domainRuntimeResumeEvidenceJson,
    undefined,
    {
      cwd,
      label: "v4RuntimeResumeEvidenceJson",
    },
  );
  const kfdAgentHubEvidenceMeta = parseJsonInputWithMeta(
    kfdAgentHubEvidenceJson,
    undefined,
    { cwd, label: "kfdAgentHubEvidenceJson" },
  );
  const githubArtifactAttestationPolicies = (
    githubArtifactAttestationPolicyJsons || []
  )
    .filter(Boolean)
    .map((policyJson) =>
      parseJsonInput(policyJson, undefined, {
        cwd,
        label: "githubArtifactAttestationPolicyJsons entry",
      }),
    )
    .map(normalizeGitHubArtifactAttestationPolicy);
  return {
    consumerPolicyCertificationMeta,
    domainRuntimeResumeEvidence,
    githubArtifactAttestationPolicies,
    kfdAgentHubEvidenceMeta,
  };
}
export function readPassportCollectionInputs({
  anchorManifestJson,
  assetsJson,
  basePassportJson,
  buildFactsJsons,
  buildSummaryJson,
  cwd,
  distTagEvidenceJson,
  domainConsumerPolicyCertificationJson,
  domainRuntimeResumeEvidenceJson,
  githubArtifactAttestationPolicyJsons,
  impactJson,
  invariantPassportCommand,
  invariantPassportJsons,
  kfd1WitnessJsons,
  kfd2ClaimJsons,
  kfd3ArtifactVerifyCommand,
  kfd3ArtifactWitnessJsons,
  kfd3PrebuildWitnessJsons,
  kfdAgentHubEvidenceJson,
  packageSetJson,
  platformManifestJsons,
  publishEvidenceJson,
  releaseEvidenceJsons,
  releaseJson,
  releaseJsonExtra,
  transactionJson,
  trustedPublishingJson,
  versionMaterialJson,
}) {
  const {
    anchorManifest,
    assetsFromJson,
    impactMeta,
    packageSet,
    publishEvidenceMeta,
    release,
    releaseExtra,
    transactionMeta,
    trustedPublishing,
    versionMaterial,
  } = collectPublicationInputs({
    anchorManifestJson,
    assetsJson,
    cwd,
    impactJson,
    packageSetJson,
    publishEvidenceJson,
    releaseJson,
    releaseJsonExtra,
    transactionJson,
    trustedPublishingJson,
    versionMaterialJson,
  });
  const {
    buildFactMetas,
    buildSummaryMeta,
    distTagEvidenceMeta,
    platformManifestMetas,
  } = collectBuildInputs({
    buildFactsJsons,
    buildSummaryJson,
    cwd,
    distTagEvidenceJson,
    platformManifestJsons,
  });
  const {
    basePassportMeta,
    invariantPassports,
    kfd1WitnessMetas,
    kfd2ClaimMetas,
    kfd3ArtifactCommandMeta,
    kfd3ArtifactWitnessMetas,
    kfd3PrebuildWitnessMetas,
    releaseEvidenceMetas,
  } = collectTrustInputs({
    basePassportJson,
    cwd,
    invariantPassportCommand,
    invariantPassportJsons,
    kfd1WitnessJsons,
    kfd2ClaimJsons,
    kfd3ArtifactVerifyCommand,
    kfd3ArtifactWitnessJsons,
    kfd3PrebuildWitnessJsons,
    releaseEvidenceJsons,
  });
  const {
    consumerPolicyCertificationMeta,
    domainRuntimeResumeEvidence,
    githubArtifactAttestationPolicies,
    kfdAgentHubEvidenceMeta,
  } = collectControllerInputs({
    cwd,
    domainConsumerPolicyCertificationJson,
    domainRuntimeResumeEvidenceJson,
    githubArtifactAttestationPolicyJsons,
    kfdAgentHubEvidenceJson,
  });
  return {
    anchorManifest,
    assetsFromJson,
    basePassportMeta,
    buildFactMetas,
    buildSummaryMeta,
    consumerPolicyCertificationMeta,
    distTagEvidenceMeta,
    domainRuntimeResumeEvidence,
    githubArtifactAttestationPolicies,
    impactMeta,
    invariantPassports,
    kfd1WitnessMetas,
    kfd2ClaimMetas,
    kfd3ArtifactCommandMeta,
    kfd3ArtifactWitnessMetas,
    kfd3PrebuildWitnessMetas,
    kfdAgentHubEvidenceMeta,
    packageSet,
    platformManifestMetas,
    publishEvidenceMeta,
    release,
    releaseEvidenceMetas,
    releaseExtra,
    transactionMeta,
    trustedPublishing,
    versionMaterial,
  };
}
