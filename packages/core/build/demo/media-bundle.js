import {
  stableJson,
  sha256,
  writeJson,
  ensureEmptyDirectory,
  listFiles,
  writeChecksums,
  required,
  copyFile,
} from "./io.js";
import { RENDITION_VALIDATION_HELPERS } from "./schema.js";
import { loadMediaProfile } from "./media-profile.js";
import { loadMediaInspection } from "./media-inspection.js";
import { verifyRendererOutput } from "./renderer-evidence.js";
import { verifyGate } from "./gate.js";
import fs from "node:fs";
import path from "node:path";
import { readRendererManifest } from "./renditions.js";

export function finalizeMedia(request) {
  const gateBundle = path.resolve(required(request, "gateBundle"));
  const renderOutput = path.resolve(required(request, "renderOutput"));
  const output = path.resolve(required(request, "output"));
  const rendererImage = required(request, "rendererImage");
  const gateRoot = required(request, "gateRoot");
  const sourceSha = required(request, "sourceSha");
  const mediaProfile = request["mediaProfile"] || "archive-v1";
  const selectedProfile = loadMediaProfile(mediaProfile).profile;
  const mediaInspectionPath = request["mediaInspection"]
    ? path.resolve(request["mediaInspection"])
    : "";
  const mediaInspection =
    selectedProfile.mode === "web-delivery"
      ? loadMediaInspection(
          required({ mediaInspection: mediaInspectionPath }, "mediaInspection"),
          renderOutput,
          rendererImage,
        )
      : null;
  verifyGate({
    bundle: gateBundle,
    expectedRoot: gateRoot,
    rendererImage: rendererImage,
    sourceSha: sourceSha,
    mediaProfile: mediaProfile,
  });
  const terminalCapturePath = path.join(gateBundle, "terminal-capture.json");
  const renditionSetPath = path.join(gateBundle, "rendition-set.json");
  const verifiedRenderer = verifyRendererOutput(
    renderOutput,
    rendererImage,
    {
      scene: path.join(gateBundle, "scene.json"),
      transcript: path.join(gateBundle, "complete-transcript.txt"),
      projection: path.join(gateBundle, "public-projection.json"),
      ...(fs.existsSync(terminalCapturePath)
        ? { terminalCapture: terminalCapturePath }
        : {}),
      ...(fs.existsSync(renditionSetPath)
        ? { renditionSet: renditionSetPath }
        : {}),
    },
    {
      mediaProfile,
      inspectMedia: mediaInspection?.inspectMedia,
      inspectionRoot: mediaInspection?.inspectionRoot || "",
    },
  );
  ensureEmptyDirectory(output, "media bundle");
  for (const name of listFiles(renderOutput)) {
    const destination =
      name === "checksums.sha256" ? "renderer-checksums.sha256" : name;
    copyFile(path.join(renderOutput, name), path.join(output, destination));
  }
  copyFile(
    path.join(gateBundle, "gate-receipt.json"),
    path.join(output, "gate-receipt.json"),
  );
  if (mediaInspectionPath)
    copyFile(mediaInspectionPath, path.join(output, "media-inspection.json"));
  const commonReceipt = {
    status: "passed",
    sourceSha,
    qualifiedGateRoot: gateRoot,
    rendererImage,
    rendererManifestRoot: sha256(
      readRendererManifest(
        path.join(renderOutput, "manifest.json"),
        RENDITION_VALIDATION_HELPERS,
      ).bytes,
    ),
  };
  const mediaReceipt =
    selectedProfile.mode === "archive"
      ? { schema: "buildchain.auditable-demo-media/v1", ...commonReceipt }
      : {
          schema: "buildchain.auditable-demo-media/v2",
          ...commonReceipt,
          qualification: verifiedRenderer.qualification,
          qualificationRoot: verifiedRenderer.qualification.qualificationRoot,
        };
  writeJson(path.join(output, "media-receipt.json"), mediaReceipt);
  const root = writeChecksums(output);
  const artifactName = `auditable-demo-media-${sourceSha.slice(0, 12)}-${root.slice(7, 23)}`;
  return {
    status: "passed",
    root,
    artifactName,
    mediaProfile,
    mediaQualificationRoot: verifiedRenderer.qualification.qualificationRoot,
  };
}
