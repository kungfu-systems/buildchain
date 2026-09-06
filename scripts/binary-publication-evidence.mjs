import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SETTLEMENT_ASSET,
  verifyPublicationSettlement,
} from "./v4-publication-settlement.mjs";
import { releaseAssetClient } from "./release-asset-client.mjs";

export async function readBinaryPublicationEvidence({
  client,
  repository,
  tag,
  sourceSha,
  attempts = 40,
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

async function main(mode) {
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  const client = releaseAssetClient(repository);
  if (mode === "read") {
    const settlement = await readBinaryPublicationEvidence({
      client,
      repository,
      tag,
      sourceSha: process.env.SOURCE_SHA,
    });
    const directory = ".buildchain/publication-evidence";
    client.write(`${directory}/${SETTLEMENT_ASSET}`, settlement);
    client.write(`${directory}/release.json`, {
      channel: settlement.release.channel,
    });
  } else if (mode === "publish") {
    const release = client.release(tag);
    const files = prepareBinaryAssetPaths({
      binaryDir: "dist/binary",
      passportDir: ".buildchain/release-passport",
      outputDir: ".buildchain/binary-publication",
      capabilityPath: ".buildchain/publication-authority/capability.json",
    });
    const results = await client.publish(release, files);
    client.write(".buildchain/binary-publication/readback.json", {
      repository,
      tag,
      assets: results,
    });
    console.log(JSON.stringify({ published: results.length, repository, tag }));
  } else throw new Error(`unknown binary publication mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
