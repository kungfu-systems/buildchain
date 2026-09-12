import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function publicationPath(root, relative, kind = "file") {
  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`))
    throw new Error("Publication path escapes its owned directory");
  let current = base;
  for (const part of path
    .relative(base, target)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink())
      throw new Error("Publication paths cannot traverse symbolic links");
  }
  const stat = fs.statSync(target);
  if (
    (kind === "file" && !stat.isFile()) ||
    (kind === "directory" && !stat.isDirectory())
  )
    throw new Error(`Publication expected a ${kind}`);
  return target;
}

export function publicationFile(file) {
  const size = fs.statSync(file).size;
  if (!size || size > 256 * 1024 * 1024)
    throw new Error("Publication artifact must contain 1 byte to 256 MiB");
  const bytes = fs.readFileSync(file);
  if (!bytes.length || bytes.length > 256 * 1024 * 1024)
    throw new Error("Publication artifact must contain 1 byte to 256 MiB");
  return {
    bytes,
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

export function writeImmutablePublicationFile(file, bytes) {
  // Refuse parent symlinks before mkdir/write, including during recovery into
  // an existing output directory.
  let parent = path.dirname(path.resolve(file));
  while (parent !== path.dirname(parent)) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink())
      throw new Error("Publication output cannot traverse symbolic links");
    parent = path.dirname(parent);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, bytes, { flag: "wx" });
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      fs.lstatSync(file).isSymbolicLink() ||
      !fs.readFileSync(file).equals(Buffer.from(bytes))
    )
      throw new Error(
        `Publication refuses conflicting retained bytes: ${path.basename(file)}`,
      );
  }
  return file;
}
