import path from "node:path";

export function readNpmPackResult(stdout) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed)
    ? parsed
    : typeof parsed?.name === "string"
      ? [parsed]
      : parsed && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
  if (entries.length !== 1)
    throw new Error("npm pack must return exactly one package");
  const pack = entries[0];
  if (
    typeof pack?.name !== "string" ||
    !pack.name ||
    typeof pack?.version !== "string" ||
    !pack.version
  ) {
    throw new Error("npm pack did not return package name and version");
  }
  if (
    typeof pack.filename !== "string" ||
    !pack.filename.endsWith(".tgz") ||
    /[/\\]/u.test(pack.filename) ||
    path.basename(pack.filename) !== pack.filename
  )
    throw new Error("npm pack must return a local tarball filename");
  return pack;
}
