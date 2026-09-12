import { createHash } from "node:crypto";
import { object, text, choice } from "../../consumer/contract/shape.js";
import { recordDigest } from "../../release/discussion/envelope.js";

export const MATERIAL_KINDS = [
  "artifact",
  "checkpoint",
  "receipt",
  "passport",
  "provider-readback",
];

export function materialReference(value, attempt, repository = "") {
  object(
    value,
    ["id", "kind", "digest", "bytes", "url", "generation", "producerAttempt"],
    [],
    "material",
  );
  text(value.id, "material.id", /^[a-z][a-z0-9._/-]*$/u);
  choice(value.kind, MATERIAL_KINDS, "material.kind");
  text(value.digest, "material.digest", /^sha256:[0-9a-f]{64}$/u);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1)
    throw new Error("Invalid material byte size");
  const url = new URL(value.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["github.com", "api.github.com"].includes(url.hostname)
  )
    throw new Error(
      "Material must use a permanent GitHub URL without credentials or signed queries",
    );
  if (
    repository &&
    !(url.hostname === "github.com"
      ? url.pathname.startsWith(`/${repository}/releases/download/`) ||
        url.pathname.startsWith(`/${repository}/actions/runs/`)
      : url.pathname.startsWith(`/repos/${repository}/actions/artifacts/`) ||
        url.pathname.startsWith(`/repos/${repository}/releases/assets/`))
  )
    throw new Error("Material belongs to another consumer repository");
  if (
    value.generation !== attempt.generation ||
    value.producerAttempt !== attempt.id
  )
    throw new Error(
      "Material is not qualified for this exact attempt and generation",
    );
  return { ...value };
}

export function verifyMaterialBytes(reference, bytes) {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.length !== reference.bytes || digest !== reference.digest)
    throw new Error(`Material integrity mismatch: ${reference.id}`);
  return { id: reference.id, digest, bytes: bytes.length };
}

export function indexMaterials(index, references, attempt) {
  for (const reference of references) {
    materialReference(reference, attempt);
    const old = index[reference.id];
    if (old && recordDigest(old) !== recordDigest(reference))
      throw new Error(`Immutable material identity conflict: ${reference.id}`);
    index[reference.id] = { ...reference };
  }
  return index;
}
