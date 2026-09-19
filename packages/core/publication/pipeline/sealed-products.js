import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { recordDigest } from "../../release/discussion/envelope.js";
import {
  publicationFile,
  publicationPath,
  writeImmutablePublicationFile,
} from "./files.js";

export async function retainPipelineProducts(archive, qualified, bundles) {
  const retained = [];
  for (const artifact of qualified.artifacts) {
    const bundle = bundles.find(
      ({ manifest }) => manifest.root === artifact.manifestRoot,
    );
    if (!bundle)
      throw new Error("Qualified product has no exact source manifest");
    const file = publicationFile(
      publicationPath(bundle.directory, artifact.file),
    );
    if (file.digest !== artifact.digest || file.size !== artifact.size)
      throw new Error("Qualified product changed before durable retention");
    const handle = await archive.put(file.bytes, {
      name: `${artifact.digest.slice(7)}-${path.basename(artifact.file)}`,
      mediaType: "application/octet-stream",
    });
    await verifiedBytes(archive, handle, artifact);
    retained.push({ id: artifact.id, handle });
  }
  const body = {
    schema: "buildchain.pipeline-sealed-products/v1",
    qualificationRoot: qualified.root,
    products: retained,
  };
  return { ...body, root: recordDigest(body) };
}

async function verifiedBytes(archive, handle, artifact) {
  if (handle.digest !== artifact.digest || handle.size !== artifact.size)
    throw new Error("Retained product handle does not bind qualified bytes");
  const bytes = Buffer.from(await archive.read(handle));
  if (
    bytes.length !== artifact.size ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
      artifact.digest
  )
    throw new Error("Retained product readback differs from qualified bytes");
  return bytes;
}

export async function restorePipelineProducts(
  archive,
  qualified,
  sealed,
  directory,
) {
  const { root, ...body } = sealed;
  if (
    root !== recordDigest(body) ||
    sealed.qualificationRoot !== qualified.root ||
    recordDigest(sealed.products.map(({ id }) => id)) !==
      recordDigest(qualified.artifacts.map(({ id }) => id))
  )
    throw new Error(
      "Retained products must cover the exact qualification inventory",
    );
  fs.mkdirSync(directory, { recursive: true });
  for (const artifact of qualified.artifacts) {
    const { handle } = sealed.products.find(({ id }) => id === artifact.id);
    const bytes = await verifiedBytes(archive, handle, artifact);
    const target = path.resolve(directory, artifact.file);
    if (!target.startsWith(`${path.resolve(directory)}${path.sep}`))
      throw new Error("Retained product path escapes its directory");
    writeImmutablePublicationFile(target, bytes);
    publicationPath(directory, artifact.file);
  }
  return directory;
}
