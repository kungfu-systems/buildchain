import fs from "node:fs";
import path from "node:path";
import { selectPayloadArtifacts } from "../candidate/payloads.js";
export function candidateArtifactNames({
  passport,
  selected,
  artifacts,
  artifactPatterns,
}) {
  const names = new Set([selected.passport.name, selected.summary.name]);
  for (const reference of passport.controllerReceipts || []) {
    if (!reference.artifact)
      throw new Error(
        `Passport controller receipt ${reference.controllerId} has no artifact identity`,
      );
    names.add(reference.artifact);
  }
  for (const platform of passport.platformMatrix || []) {
    names.add(platform.artifactName);
    const diagnosticsArtifactName = `${selected.prefix}-diagnostics-${platform.platformId}-${selected.sourceSha}`;
    if (artifacts.some((artifact) => artifact.name === diagnosticsArtifactName))
      names.add(diagnosticsArtifactName);
  }
  const manifestPattern = new RegExp(
    `^${selected.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-manifest-.+-${selected.sourceSha}$`,
  );
  for (const artifact of artifacts) {
    if (manifestPattern.test(String(artifact.name || "")))
      names.add(artifact.name);
  }
  const publicationNames = new Set(
    selectPayloadArtifacts({
      artifacts,
      artifactName: selected.prefix,
      sourceSha: selected.sourceSha,
      patterns: artifactPatterns,
    }).map((artifact) => artifact.name),
  );
  for (const name of publicationNames) names.add(name);
  return { names, publicationNames };
}

export function normalizePlatformManifests(downloads, passport) {
  const manifests = [];
  const evidenceByArtifact = new Map();
  const platformById = new Map(
    (passport.platformMatrix || []).map((entry) => [
      String(entry.platformId || ""),
      entry,
    ]),
  );
  const seenPlatformIds = new Set();
  function addEvidence(artifactName, files) {
    if (!artifactName) return;
    const evidenceFiles = evidenceByArtifact.get(artifactName) || new Map();
    for (const file of files) {
      const existing = evidenceFiles.get(file.path);
      if (
        existing &&
        (existing.size !== file.size || existing.sha256 !== file.sha256)
      ) {
        throw new Error(
          `platform evidence disagrees for ${artifactName}/${file.path}`,
        );
      }
      evidenceFiles.set(file.path, file);
    }
    evidenceByArtifact.set(artifactName, evidenceFiles);
  }
  for (const download of downloads) {
    if (String(download.artifact.name).includes("-manifest-"))
      for (const file of download.files.filter(
        (entry) => path.basename(entry.path) === "manifest.json",
      )) {
        const manifest = JSON.parse(fs.readFileSync(file.absolutePath, "utf8"));
        const platformId = String(
          manifest.platform?.id || manifest.platformId || "",
        );
        const expectedPlatform = platformById.get(platformId);
        if (!expectedPlatform) continue;
        if (seenPlatformIds.has(platformId))
          throw new Error(
            `candidate recovery found duplicate platform manifest for ${platformId}`,
          );
        if (
          manifest.artifactName &&
          manifest.artifactName !== expectedPlatform.artifactName
        ) {
          throw new Error(
            `candidate recovery platform manifest ${platformId} names unexpected artifact ${manifest.artifactName}`,
          );
        }
        manifest.artifactName = expectedPlatform.artifactName;
        seenPlatformIds.add(platformId);
        manifests.push(manifest);
        addEvidence(manifest.artifactName, download.record.files);
      }
    if (String(download.artifact.name).includes("-diagnostics-")) {
      const diagnosticsFiles = download.files.filter(
        (entry) => path.basename(entry.path) === "diagnostics.json",
      );
      if (diagnosticsFiles.length === 1) {
        const diagnostics = JSON.parse(
          fs.readFileSync(diagnosticsFiles[0].absolutePath, "utf8"),
        );
        addEvidence(
          String(diagnostics.links?.artifactName || ""),
          download.record.files,
        );
      }
    }
  }
  const evidence = [...evidenceByArtifact].map(([artifactName, files]) => ({
    artifactName,
    files: [...files.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  }));
  return { manifests, evidence };
}

export function normalizeControllerReceipts(downloads, passport) {
  const artifactNames = new Set(
    (passport.controllerReceipts || []).map((reference) => reference.artifact),
  );
  const receipts = [];
  for (const download of downloads.filter((entry) =>
    artifactNames.has(entry.artifact.name),
  )) {
    const candidates = download.files
      .filter((file) => file.path.endsWith(".json"))
      .map((file) => {
        try {
          return JSON.parse(fs.readFileSync(file.absolutePath, "utf8"));
        } catch {
          return undefined;
        }
      })
      .filter(
        (value) =>
          value?.contract === "buildchain.controller-evidence/v1" &&
          value?.kind === "receipt",
      );
    if (candidates.length !== 1)
      throw new Error(
        `controller artifact ${download.artifact.name} must contain exactly one controller receipt`,
      );
    receipts.push(candidates[0]);
  }
  return receipts;
}

export function normalizeProductPayloadManifests(downloads) {
  return downloads.flatMap((download) =>
    download.files
      .filter(
        (file) => path.basename(file.path) === "product-payload-manifest.json",
      )
      .map((file) => JSON.parse(fs.readFileSync(file.absolutePath, "utf8"))),
  );
}
