import {
  canonicalJson,
  recordDigest,
} from "../../release/discussion/envelope.js";
import {
  materialReference,
  verifyMaterialBytes,
} from "../attempt/materials.js";

// Receipts are retained before the atomic journal references them. An interrupted
// upload can leave unreferenced material; it cannot advance attempt authority.
export function pipelineMaterials(archive, { repository, attempt }) {
  async function retain(id, receipt, kind = "receipt") {
    const bytes = Buffer.from(`${canonicalJson(receipt)}\n`);
    const handle = await archive.put(bytes, {
      name: `${id.replaceAll("/", "-")}.json`,
      mediaType: "application/json",
    });
    const reference = materialReference(
      {
        id,
        kind,
        digest: handle.digest,
        bytes: handle.size,
        url: `https://api.github.com/repos/${repository}/releases/assets/${handle.id}`,
        producerAttempt: attempt.id,
        generation: attempt.generation,
      },
      attempt,
      repository,
    );
    verifyMaterialBytes(reference, await archive.read(handle));
    return reference;
  }
  async function read(reference) {
    materialReference(reference, attempt, repository);
    const prefix = `https://api.github.com/repos/${repository}/releases/assets/`;
    if (!reference.url.startsWith(prefix))
      throw new Error(
        "Pipeline receipt is not in its retained material archive",
      );
    const id = reference.url.slice(prefix.length);
    if (!/^[1-9][0-9]*$/u.test(id) || !Number.isSafeInteger(Number(id)))
      throw new Error("Pipeline receipt asset identity is invalid");
    const bytes = await archive.read({
      id: Number(id),
      size: reference.bytes,
      digest: reference.digest,
    });
    verifyMaterialBytes(reference, bytes);
    const receipt = JSON.parse(bytes.toString("utf8"));
    // Normalize the supported JSON value domain, rejecting undefined or NaN
    // from alternate injected archive implementations before returning it.
    recordDigest(receipt);
    return receipt;
  }
  return { retain, read };
}
