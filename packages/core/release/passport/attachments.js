import { resolveJsonInputPath } from "./files.js";
import {
  nonEmptyString,
  RELEASE_EVIDENCE_ATTACHMENT_CONTRACT,
  optionalString,
} from "./identity.js";
import { sha256Text, stableJson } from "./json.js";
export function normalizeReleaseEvidenceAttachment(
  meta,
  { cwd, expectedSourceSha, expectedTag, expectedChannel, index } = {},
) {
  const document = meta?.value;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`releaseEvidenceJsons[${index}] must be a JSON object`);
  }
  const inputPath = resolveJsonInputPath(meta.path, { cwd });
  if (!inputPath) {
    throw new Error(
      `releaseEvidenceJsons[${index}] must be an existing JSON file path`,
    );
  }
  if (Number(document.schemaVersion) !== 1) {
    throw new Error(`releaseEvidenceJsons[${index}].schemaVersion must be 1`);
  }
  const id = nonEmptyString(document.id, `releaseEvidenceJsons[${index}].id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(
      `releaseEvidenceJsons[${index}].id must use only letters, digits, dot, underscore, or hyphen`,
    );
  }
  const contract = nonEmptyString(
    document.contract,
    `releaseEvidenceJsons[${index}].contract`,
  );
  const release = document.release;
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error(
      `releaseEvidenceJsons[${index}].release must be a JSON object`,
    );
  }
  const sourceSha = nonEmptyString(
    release.sourceSha,
    `releaseEvidenceJsons[${index}].release.sourceSha`,
  );
  const tag = nonEmptyString(
    release.tag,
    `releaseEvidenceJsons[${index}].release.tag`,
  );
  const channel = nonEmptyString(
    release.channel,
    `releaseEvidenceJsons[${index}].release.channel`,
  );
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
    throw new Error(
      `releaseEvidenceJsons[${index}].release.sourceSha must be a full 40-character Git SHA`,
    );
  }
  if (!expectedSourceSha || sourceSha !== expectedSourceSha) {
    throw new Error(
      `releaseEvidenceJsons[${index}].release.sourceSha must match the release passport source SHA`,
    );
  }
  if (!expectedTag || tag !== expectedTag) {
    throw new Error(
      `releaseEvidenceJsons[${index}].release.tag must match the release passport tag`,
    );
  }
  if (!expectedChannel || channel !== expectedChannel) {
    throw new Error(
      `releaseEvidenceJsons[${index}].release.channel must match the release passport channel`,
    );
  }
  const relativePath = `release-evidence-${id}.json`;
  return {
    document,
    inputPath,
    reference: {
      schemaVersion: 1,
      contract: RELEASE_EVIDENCE_ATTACHMENT_CONTRACT,
      id,
      kind: optionalString(document.kind || "product-release-evidence"),
      documentContract: contract,
      path: relativePath,
      sha256: sha256Text(stableJson(document)),
      release: { sourceSha, tag, channel },
    },
  };
}
