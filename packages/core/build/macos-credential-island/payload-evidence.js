import fs from "node:fs";
import path from "node:path";
import { sha256File } from "./lib.js";

// Bind both published containers and the selected payload to the credential
// island evidence. Provider run admission remains the caller responsibility.
export function verifyMacosCredentialPayloads({
  evidenceDocument,
  manifest,
  payloadPath,
}) {
  const payloads = evidenceDocument.artifacts;
  if (
    !Array.isArray(payloads) ||
    payloads.length !== 2 ||
    ["zip", "dmg"].some(
      (kind) => payloads.filter((item) => item.kind === kind).length !== 1,
    )
  )
    throw new Error(
      "credential evidence must bind both final ZIP and DMG bytes",
    );
  for (const item of payloads) {
    const matches = manifest.files.filter(
      (file) => path.posix.basename(file.path) === item.name,
    );
    if (
      matches.length !== 1 ||
      !item.name.endsWith(`.${item.kind}`) ||
      matches[0].size !== item.bytes ||
      `sha256:${matches[0].sha256}` !== item.sha256
    )
      throw new Error("credential final bytes do not match provider evidence");
  }
  const selected = payloads.find(
    (item) => item.name === path.basename(payloadPath),
  );
  if (
    !selected ||
    selected.bytes !== fs.statSync(payloadPath).size ||
    selected.sha256 !== sha256File(payloadPath)
  )
    throw new Error(
      "signed payload does not match credential provider evidence",
    );
}
