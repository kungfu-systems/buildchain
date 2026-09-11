import fs from "node:fs";
import path from "node:path";
import { TAIL_RESEAL_PLATFORMS } from "../tail-reseal.js";
import { readJson, sha256File } from "./files.js";
export function collectReadbacks(directory) {
  const byPlatform = new Map();
  for (const entry of fs.readdirSync(path.resolve(directory), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith("readback.json")) continue;
    const value = readJson(path.join(entry.parentPath, entry.name));
    if (byPlatform.has(value.platformId))
      throw new Error(`duplicate tail reseal readback for ${value.platformId}`);
    byPlatform.set(value.platformId, value);
  }
  return TAIL_RESEAL_PLATFORMS.map((platformId) => {
    if (!byPlatform.has(platformId))
      throw new Error(`missing tail reseal readback for ${platformId}`);
    return byPlatform.get(platformId);
  });
}

export function verifyResealProviderReadbacks({
  directory,
  signingRoot,
  releaseTailRoot,
}) {
  for (const [name, expected] of [
    ["signing-provider-readback.json", signingRoot],
    ["release-tail-provider-readback.json", releaseTailRoot],
  ]) {
    if (sha256File(path.join(directory, name)) !== expected)
      throw new Error(`${name} root mismatch`);
  }
}
