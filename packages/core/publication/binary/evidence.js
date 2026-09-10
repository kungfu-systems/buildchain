import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {
  SETTLEMENT_ASSET,
  verifyPublicationSettlement,
} from "../settlement/transaction.js";

export async function readBinaryPublicationEvidence({
  client,
  repository,
  tag,
  sourceSha,
  // Protected finalization includes PR verification, review and merge queue.
  attempts = 160,
  wait = () => new Promise((resolve) => setTimeout(resolve, 15000)),
}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let release;
    try {
      release = client.release(tag);
    } catch {
      /* Tag creation can precede Release creation. */
    }
    const assets = release?.assets || [];
    const settlements = assets.filter(({ name }) => name === SETTLEMENT_ASSET);
    const passports = assets.filter(
      ({ name }) => name === "buildchain.release.json",
    );
    if (settlements.length > 1 || passports.length > 1)
      throw new Error("ambiguous immutable publication evidence");
    if (settlements.length === 1 && passports.length === 1) {
      const settlement = JSON.parse(client.assetBytes(settlements[0]));
      const publicPassport = JSON.parse(client.assetBytes(passports[0]));
      if (
        settlement.contract !== "buildchain-v4-publication-settlement/v1" ||
        settlement.release.sourceSha !== sourceSha ||
        settlement.release.tag !== tag
      )
        throw new Error("binary publication settlement identity mismatch");
      const tagSha = client.json(
        `repos/${repository}/commits/${encodeURIComponent(tag)}`,
      ).sha;
      if (tagSha !== sourceSha)
        throw new Error("binary source does not match the exact release tag");
      verifyPublicationSettlement(settlement.documents, {
        repository,
        tag,
        sourceSha,
        publicPassport,
      });
      return settlement;
    }
    if (attempt + 1 < attempts) await wait();
  }
  throw new Error(
    "completed v4 publication evidence is not available within the bounded wait",
  );
}

export function prepareBinaryAssetPaths({
  binaryDir,
  passportDir,
  outputDir,
  capabilityPath,
}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const files = [];
  for (const directory of [binaryDir, passportDir]) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const source = path.join(directory, entry.name);
      if (
        directory === passportDir &&
        entry.name === "buildchain.release.json"
      ) {
        const renamed = path.join(outputDir, "buildchain.binary.release.json");
        fs.copyFileSync(source, renamed);
        files.push(renamed);
      } else files.push(source);
    }
  }
  if (capabilityPath) {
    const bytes = fs.readFileSync(capabilityPath);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const retained = path.join(
      outputDir,
      `buildchain.binary.capability-${digest}.json`,
    );
    fs.writeFileSync(retained, bytes);
    files.push(retained);
  }
  return files;
}

export async function writeBinaryPublicationEvidence(options) {
  const settlement = await readBinaryPublicationEvidence(options);
  const directory = path.join(
    options.workspace,
    ".buildchain/publication-evidence",
  );
  options.client.write(path.join(directory, SETTLEMENT_ASSET), settlement);
  const release = settlement.documents.passport.release;
  options.client.write(path.join(directory, "release.json"), {
    channel: release.channel,
    publishedVersion: release.version,
    versionLabel: release.version,
  });
}
