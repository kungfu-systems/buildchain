import { readNpmPackResult } from "./pack-result.js";
export function summarizePackPreview(stdout) {
  const pack = readNpmPackResult(stdout);
  const files = Array.isArray(pack?.files) ? pack.files : [];
  const bin = files.find((file) => file.path === "bin/buildchain.mjs");
  const fileEntries = files.map((file) => ({
    path: file.path,
    size: file.size,
    mode: file.mode,
  }));
  return {
    filename: pack?.filename || "",
    name: pack?.name || "",
    version: pack?.version || "",
    size: pack?.size || 0,
    unpackedSize: pack?.unpackedSize || 0,
    entryCount: pack?.entryCount || files.length,
    bundled: pack?.bundled || [],
    files: fileEntries,
    binMode: bin?.mode,
  };
}
