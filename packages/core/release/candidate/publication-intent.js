import fs from "node:fs";
import path from "node:path";
import { spawnSyncCommand } from "../../runtime/spawn-command.js";
import { selectProductPublicationIntent } from "../product-publication.js";
import { domainContentRoot } from "../../contracts/canonical-contracts.js";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function observeNpmPublicationVersions(name) {
  const result = spawnSyncCommand(
    "npm",
    [
      "view",
      name,
      "versions",
      "--json",
      "--registry=https://registry.npmjs.org/",
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/\bE404\b|404 Not Found|is not in this registry/iu.test(output))
      return [];
    throw Object.assign(
      new Error(`npm version discovery failed: ${output.trim()}`),
      { status: result.status },
    );
  }
  const parsed = JSON.parse(String(result.stdout || "[]"));
  return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
}
export function materializePublicationIntent(
  {
    artifactKind = "npm",
    packageName,
    sourceSha,
    manifestPath,
    requiredArtifactsPath,
    channel,
    targetRef,
    sourceTimestamp,
    repository,
    distTag,
    candidateVersion,
    recoveredVersion,
    outputPath,
  },
  observeVersions = observeNpmPublicationVersions,
) {
  const manifest = manifestPath ? read(manifestPath) : null,
    requiredArtifacts = read(requiredArtifactsPath);
  const name =
    artifactKind === "npm"
      ? String(packageName || manifest?.npm?.name || "").trim()
      : "";
  if (artifactKind === "npm" && !name)
    throw new Error("sealed bundle manifest does not declare npm.name");
  if (artifactKind !== "custom" && !manifest)
    throw new Error("Publication intent requires a sealed bundle manifest");
  const intent = selectProductPublicationIntent({
    channel,
    targetRef,
    sourceSha,
    sourceTimestamp,
    repository,
    artifactKind,
    packageName: name,
    ...(manifest?.npmPackages
      ? {
          npmPackages: manifest.npmPackages.map((entry) => ({
            ...entry,
            sha256: `sha256:${entry.sha256}`,
          })),
        }
      : {}),
    distTag: distTag || (channel === "alpha" ? "alpha" : "latest"),
    sealedBundleRoot: manifest?.root,
    requiredArtifactsRoot: domainContentRoot(
      "v4-product-required-artifacts",
      requiredArtifacts,
    ),
    candidateVersion,
    recoveredVersion,
    observedVersions: artifactKind === "npm" ? observeVersions(name) : [],
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(intent, null, 2) + "\n");
  return { name: name || artifactKind, intent, outputPath };
}
