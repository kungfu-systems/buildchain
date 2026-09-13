import { createHash } from "node:crypto";
import { canonicalJson } from "../../release/discussion/envelope.js";
import {
  publicationFile,
  publicationPath,
} from "../../publication/pipeline/files.js";
const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function pipelineProductPayload({
  qualified,
  documents,
  directory,
  evidence,
}) {
  const payload = (effect) => {
    if (effect.product.startsWith("evidence:")) {
      const asset = evidence.find(
        (entry) => `evidence:${entry.id}` === effect.product,
      );
      if (
        !asset ||
        sha256(asset.bytes) !== effect.digest ||
        asset.bytes.length !== effect.size
      )
        throw new Error(
          "Release evidence differs from admitted immutable bytes",
        );
      return asset.bytes;
    }
    if (effect.product === "release-passport")
      return Buffer.from(`${canonicalJson(documents.passport)}\n`);
    const artifact = qualified.artifacts.find(
      (entry) => entry.id === effect.product,
    );
    if (
      !artifact ||
      artifact.digest !== effect.digest ||
      artifact.size !== effect.size
    )
      throw new Error(
        "GitHub Release payload does not match qualified product",
      );
    const file = publicationFile(publicationPath(directory, artifact.file));
    if (file.digest !== artifact.digest || file.size !== artifact.size)
      throw new Error("GitHub Release payload bytes changed");
    return file.bytes;
  };
  return payload;
}
