import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { sha256Json } from "../../release/release-candidate.js";
import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";

export function sealPackageCandidate({ passport, tree, outputDir }) {
  requireValue(
    tree === passport.source.treeHash,
    `Package candidate tree ${tree} differs from Passport ${passport.source.treeHash}`,
  );
  const tarballs = fs
    .readdirSync(outputDir)
    .filter((name) => name.endsWith(".tgz"));
  requireValue(
    tarballs.length === 1,
    `Expected one Buildchain npm tarball, found ${tarballs.length}`,
  );
  const tarball = path.join(outputDir, tarballs[0]);
  const manifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-product-payload-manifest/v1",
    artifactName: `buildchain-package-${passport.source.headSha}`,
    manifestPath: "product-payload-manifest.json",
    candidateRoot: `sha256:${passport.candidateHash}`,
    buildSummaryRoot: `sha256:${passport.diagnostics.buildSummaryHash}`,
    source: { sha: passport.source.headSha, tree: passport.source.treeHash },
    runtimeSha: passport.buildchain.sha,
    files: [
      {
        path: tarballs[0],
        size: fs.statSync(tarball).size,
        sha256: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex")}`,
      },
    ],
  };
  manifest.root = `sha256:${sha256Json(manifest)}`;
  fs.writeFileSync(
    path.join(outputDir, manifest.manifestPath),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
export function pack(env, execute = command) {
  const base = ".buildchain/buildchain-package-candidate";
  const outputDir = path.join(base, "payload");
  fs.mkdirSync(outputDir, { recursive: true });
  const passport = JSON.parse(
    fs.readFileSync(
      path.join(base, "passport/release-candidate-passport.json"),
      "utf8",
    ),
  );
  const tree = execute("git", ["show", "-s", "--format=%T", "HEAD"], {
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  requireValue(
    tree === passport.source.treeHash,
    "Source tree must match the candidate Passport before packing",
  );
  const packed = execute(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", outputDir],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  fs.writeFileSync(path.join(base, "npm-pack.json"), packed);
  const manifest = sealPackageCandidate({ passport, tree, outputDir });
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `artifact-name=${manifest.artifactName}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({ pack });
