import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { packNpmArtifact } from "../npm/package.js";
import { sealPackageCandidate } from "./package-binding.js";
export function packageCandidateArtifact({
  sourceRoot,
  passportPath,
  outputRoot,
  environment,
}) {
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const tree = command("git", ["show", "-s", "--format=%T", "HEAD"], {
    cwd: sourceRoot,
    env: environment,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  if (tree !== passport.source.treeHash)
    throw new Error(
      "Source tree must match the candidate Passport before packing",
    );
  const outputDir = path.join(outputRoot, "payload");
  const packed = packNpmArtifact({
    cwd: sourceRoot,
    env: environment,
    outputDirectory: outputDir,
    ignoreScripts: true,
  });
  fs.writeFileSync(path.join(outputRoot, "npm-pack.json"), packed.rawResult);
  return sealPackageCandidate({ passport, tree, outputDir });
}
export function packageCandidateArtifactAction(core, env) {
  const sourceRoot = path.resolve(env.GITHUB_WORKSPACE);
  const outputRoot = path.join(
    sourceRoot,
    ".buildchain/buildchain-package-candidate",
  );
  const manifest = packageCandidateArtifact({
    sourceRoot,
    passportPath: path.join(
      outputRoot,
      "passport/release-candidate-passport.json",
    ),
    outputRoot,
    environment: Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("INPUT_")),
    ),
  });
  core.setOutput("artifact-name", manifest.artifactName);
}
