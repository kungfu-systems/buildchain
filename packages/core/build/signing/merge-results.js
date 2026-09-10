import {
  required,
  safeSigningId,
  signingFilesNamed,
  signingFileDigest,
  resolveSigningPath,
  writeSigningResultIndex,
} from "./files.js";
import fs from "node:fs";
import path from "node:path";

export function mergeArtifactSigningResults({ inputRoot, outputRoot } = {}) {
  const input = path.resolve(required(inputRoot, "signing result input root"));
  const output = path.resolve(
    required(outputRoot, "signing result output root"),
  );
  fs.mkdirSync(output, { recursive: true });
  const merged = [];
  const seen = new Set();
  for (const indexPath of signingFilesNamed(input, "index.json")) {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (index.contract !== "kungfu-buildchain-artifact-signing-result-index/v1")
      continue;
    for (const entry of index.results || []) {
      if (seen.has(entry.id))
        throw new Error(`duplicate signing result: ${entry.id}`);
      seen.add(entry.id);
      const sourceResult = path.resolve(path.dirname(indexPath), entry.result);
      const sourceDirectory = path.dirname(sourceResult);
      const relative = path.relative(path.dirname(indexPath), sourceDirectory);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("signing result escapes provider root");
      const destinationName = safeSigningId(entry.id);
      const destination = path.join(output, destinationName);
      fs.cpSync(sourceDirectory, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      merged.push({
        ...entry,
        result: `${destinationName}/${path.basename(sourceResult)}`,
        ...(entry.payload
          ? {
              payload: `${destinationName}/${path
                .relative(
                  sourceDirectory,
                  path.resolve(path.dirname(indexPath), entry.payload),
                )
                .split(path.sep)
                .join("/")}`,
            }
          : {}),
        ...(entry.envelope
          ? {
              envelope: `${destinationName}/${path
                .relative(
                  sourceDirectory,
                  path.resolve(path.dirname(indexPath), entry.envelope),
                )
                .split(path.sep)
                .join("/")}`,
            }
          : {}),
        ...(entry.receipt
          ? {
              receipt: `${destinationName}/${path
                .relative(
                  sourceDirectory,
                  path.resolve(path.dirname(indexPath), entry.receipt),
                )
                .split(path.sep)
                .join("/")}`,
            }
          : {}),
      });
    }
  }
  if (merged.length === 0) throw new Error("no artifact signing results found");
  merged.sort((a, b) => a.id.localeCompare(b.id));
  return writeSigningResultIndex(output, merged);
}
