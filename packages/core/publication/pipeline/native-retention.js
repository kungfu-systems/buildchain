import fs from "node:fs";
import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import {
  publicationFile,
  publicationPath,
  writeImmutablePublicationFile,
} from "./files.js";

export function nativeResultFiles(directory, relative = "", files = []) {
  for (const entry of fs.readdirSync(
    publicationPath(directory, relative || ".", "directory"),
    { withFileTypes: true },
  )) {
    const file = path.posix.join(relative, entry.name);
    if (file.split("/").length > 16)
      throw new Error("Native result inventory exceeds its bounded transport");
    if (entry.isDirectory()) nativeResultFiles(directory, file, files);
    else if (entry.isFile()) files.push(file);
    else
      throw new Error(
        "Native result retention rejects links and special files",
      );
    if (files.length > 256)
      throw new Error("Native result inventory exceeds its bounded transport");
  }
  return files.sort();
}

export async function retainPipelineNativeResult(archive, directory) {
  const files = [];
  for (const file of nativeResultFiles(directory)) {
    const observed = publicationFile(publicationPath(directory, file));
    const handle = await archive.put(observed.bytes, {
      name: `${observed.digest.slice(7)}-${path.posix.basename(file)}`,
      mediaType: "application/octet-stream",
    });
    if (
      handle.digest !== observed.digest ||
      handle.size !== observed.size ||
      !Buffer.from(await archive.read(handle)).equals(observed.bytes)
    )
      throw new Error(
        "Native result retention differs from verified provider bytes",
      );
    files.push({ file, handle });
  }
  const body = { schema: "buildchain.pipeline-native-result-files/v1", files };
  return { ...body, root: recordDigest(body) };
}

export async function restorePipelineNativeResult(
  archive,
  retained,
  directory,
) {
  const { root, ...body } = retained;
  if (
    body.schema !== "buildchain.pipeline-native-result-files/v1" ||
    root !== recordDigest(body) ||
    !Array.isArray(body.files) ||
    !body.files.length ||
    body.files.length > 256 ||
    new Set(body.files.map((file) => file.file)).size !== body.files.length
  )
    throw new Error("Native retained result has an invalid file inventory");
  fs.mkdirSync(directory, { recursive: true });
  const output = fs.mkdtempSync(path.join(directory, "native-restore-"));
  for (const { file, handle } of body.files) {
    if (
      typeof file !== "string" ||
      !file ||
      file.includes("\\") ||
      path.posix.isAbsolute(file) ||
      file.split("/").some((part) => !part || part === "." || part === "..") ||
      file.split("/").length > 16
    )
      throw new Error("Native retained path escapes its owned directory");
    const bytes = Buffer.from(await archive.read(handle));
    const target = writeImmutablePublicationFile(
      path.join(output, file),
      bytes,
    );
    const observed = publicationFile(target);
    if (observed.digest !== handle.digest || observed.size !== handle.size)
      throw new Error(
        "Native restored bytes differ from their retained handle",
      );
  }
  return output;
}
