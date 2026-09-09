import {
  optionalString,
  KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT,
} from "./identity.js";
import { sha256Text, stableJson } from "./json.js";
export function normalizeAnchorManifest(meta) {
  const value = meta?.value;
  if (!value) {
    return undefined;
  }
  return {
    path: optionalString(value.path || meta.path),
    sha256: optionalString(value.sha256 || meta.sha256),
    fields:
      value.fields &&
      typeof value.fields === "object" &&
      !Array.isArray(value.fields)
        ? value.fields
        : value,
  };
}
export function normalizeEvidenceDocument(meta, label) {
  const value = meta?.value;
  if (!value) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return {
    path: optionalString(meta.path),
    sha256: optionalString(meta.sha256),
    fields: value,
  };
}
export function normalizeKfdAgentHubEvidence(meta) {
  const value = meta?.value;
  if (!value) return undefined;
  if (value.contract !== "kungfu-buildchain-kfd-agent-hub-evidence/v1") {
    throw new Error(
      "kfdAgentHubEvidence must be kungfu-buildchain-kfd-agent-hub-evidence/v1",
    );
  }
  if (value.qualifying !== false || value.certification !== false) {
    throw new Error(
      "kfdAgentHubEvidence must remain nonqualifying and non-certifying",
    );
  }
  for (const [label, root] of [
    ["report.digest", value.report?.digest],
    ["lock.root", value.lock?.root],
    ["scope.adapterArtifactDigest", value.scope?.adapterArtifactDigest],
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(optionalString(root))) {
      throw new Error(`kfdAgentHubEvidence.${label} must be a sha256 root`);
    }
  }
  if (
    value.verification?.valid !== true ||
    value.verification?.contract !==
      "kungfu-buildchain-kfd-agent-hub-verification/v1"
  ) {
    throw new Error(
      "kfdAgentHubEvidence.verification must bind a valid Buildchain Agent Hub verification",
    );
  }
  if (
    value.kfd?.package?.name !== "@kungfu-tech/kfd" ||
    !value.kfd?.package?.version
  ) {
    throw new Error(
      "kfdAgentHubEvidence must bind an exact @kungfu-tech/kfd package version",
    );
  }
  if (
    value.kfd?.profile?.id !== "kfd-agent-hub-conformance" ||
    value.kfd?.suite?.id !== "kfd-agent-hub-20"
  ) {
    throw new Error(
      "kfdAgentHubEvidence must bind the KFD Agent Hub conformance profile and fixed suite",
    );
  }
  const evidenceDigest = `sha256:${sha256Text(stableJson(value))}`;
  return {
    schemaVersion: 1,
    contract: KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT,
    evidenceContract: value.contract,
    evidenceDigest,
    reportDigest: value.report.digest,
    lockRoot: value.lock.root,
    sourceCut: value.kfd,
    scope: value.scope,
    qualifying: false,
    certification: false,
    claimBoundary: optionalString(value.claimBoundary),
  };
}
export function normalizePlatformArtifactManifest(meta, index = 0) {
  const normalized = normalizeEvidenceDocument(
    meta,
    `platformArtifactManifests[${index}]`,
  );
  if (!normalized) {
    return undefined;
  }
  const fields = normalized.fields || {};
  return {
    ...normalized,
    platform: optionalString(
      fields.platform?.id || fields.platformId || fields.platform || "",
    ),
    artifactName: optionalString(
      fields.artifactName || fields.links?.artifactName || "",
    ),
  };
}
