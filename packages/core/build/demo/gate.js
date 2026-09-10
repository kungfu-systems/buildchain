import {
  DIGEST_PATTERN,
  invariant,
  stableJson,
  sha256,
  readRegular,
  readJson,
  writeJson,
  ensureEmptyDirectory,
  listFiles,
  writeChecksums,
  verifyChecksums,
  required,
  copyFile,
} from "./io.js";
import { OPTIONAL_ADAPTER_FILES, validateSourceCoordinate } from "./schema.js";
import { validateAdapterOutput } from "./adapter.js";
import { loadMediaProfile } from "./media-profile.js";
import { loadMediaInspection } from "./media-inspection.js";
import { verifyRendererOutput } from "./renderer-evidence.js";
import fs from "node:fs";
import path from "node:path";

export function renditionInputRoots(root, renditions) {
  return renditions.map((rendition) => ({
    id: rendition.id,
    role: rendition.role,
    captureRoot: rendition.captureRoot,
    sceneRoot: sha256(
      readRegular(
        path.join(root, rendition.files.scene),
        `${rendition.id} scene`,
      ),
    ),
    transcriptRoot: sha256(
      readRegular(
        path.join(root, rendition.files.transcript),
        `${rendition.id} transcript`,
      ),
    ),
    projectionRoot: sha256(
      readRegular(
        path.join(root, rendition.files.projection),
        `${rendition.id} projection`,
      ),
    ),
  }));
}

export function finalizeGate(request) {
  const adapterOutput = path.resolve(required(request, "adapterOutput"));
  const smokeInput = path.resolve(required(request, "smokeInput"));
  const smokeOutput = path.resolve(required(request, "smokeOutput"));
  const sourceCoordinatePath = path.resolve(
    required(request, "sourceCoordinate"),
  );
  const diagnostics = path.resolve(required(request, "diagnostics"));
  const output = path.resolve(required(request, "output"));
  const rendererImage = required(request, "rendererImage");
  const adapterRelative = required(request, "adapter");
  const sourceSha = required(request, "sourceSha");
  const mediaProfile = request["mediaProfile"] || "archive-v1";
  invariant(/^[0-9a-f]{40}$/.test(sourceSha), "source SHA must be exact");
  const normalized = validateAdapterOutput(adapterOutput);
  const selectedProfile = loadMediaProfile(mediaProfile).profile;
  const mediaInspectionPath = request["mediaInspection"]
    ? path.resolve(request["mediaInspection"])
    : "";
  const mediaInspection =
    selectedProfile.mode === "web-delivery"
      ? loadMediaInspection(
          required({ mediaInspection: mediaInspectionPath }, "mediaInspection"),
          smokeOutput,
          rendererImage,
        )
      : null;
  const verifiedSmoke = verifyRendererOutput(
    smokeOutput,
    rendererImage,
    {
      scene: path.join(smokeInput, "scene.json"),
      transcript: path.join(smokeInput, "complete-transcript.txt"),
      projection: path.join(smokeInput, "public-projection.json"),
    },
    {
      mediaProfile,
      inspectMedia: mediaInspection?.inspectMedia,
      inspectionRoot: mediaInspection?.inspectionRoot || "",
    },
  );
  const sourceCoordinate = validateSourceCoordinate(
    readJson(sourceCoordinatePath, "source artifact coordinate"),
  );
  invariant(
    sourceCoordinate.sourceSha === sourceSha,
    "source artifact coordinate SHA mismatch",
  );
  ensureEmptyDirectory(output, "gate bundle");
  fs.writeFileSync(
    path.join(output, "complete-transcript.txt"),
    normalized.transcript,
  );
  writeJson(path.join(output, "scene.json"), normalized.scene);
  writeJson(path.join(output, "public-projection.json"), normalized.projection);
  for (const name of OPTIONAL_ADAPTER_FILES) {
    if (fs.existsSync(path.join(adapterOutput, name))) {
      copyFile(path.join(adapterOutput, name), path.join(output, name));
    }
  }
  copyFile(sourceCoordinatePath, path.join(output, "source-artifact.json"));
  copyFile(
    path.join(diagnostics, "adapter.json"),
    path.join(output, "adapter.json"),
  );
  for (const name of listFiles(smokeOutput)) {
    copyFile(path.join(smokeOutput, name), path.join(output, "smoke", name));
  }
  writeJson(path.join(output, "gate-receipt.json"), {
    schema: "buildchain.auditable-demo-gate/v1",
    status: "passed",
    sourceRepository: sourceCoordinate.repository,
    sourceSha,
    sourceArtifact: {
      id: sourceCoordinate.id,
      name: sourceCoordinate.name,
      digest: sourceCoordinate.digest,
      runId: sourceCoordinate.runId,
      expiresAt: sourceCoordinate.expiresAt,
    },
    adapter: {
      path: adapterRelative,
      sha256: readJson(
        path.join(diagnostics, "adapter.json"),
        "adapter execution",
      ).sha256,
      argumentsRoot: readJson(
        path.join(diagnostics, "adapter.json"),
        "adapter execution",
      ).argumentsRoot,
    },
    renderer: {
      image: rendererImage,
      smokeManifestRoot: sha256(
        readRegular(path.join(smokeOutput, "manifest.json"), "smoke manifest"),
      ),
      mediaProfile,
      mediaQualificationRoot: verifiedSmoke.qualification.qualificationRoot,
    },
    qualifiedInputs: {
      transcript: sha256(
        readRegular(path.join(output, "complete-transcript.txt"), "transcript"),
      ),
      projection: sha256(
        readRegular(path.join(output, "public-projection.json"), "projection"),
      ),
      scene: sha256(readRegular(path.join(output, "scene.json"), "scene")),
      ...(normalized.terminalCapture
        ? {
            terminalCapture: {
              schema: normalized.terminalCapture.schema,
              root: sha256(
                readRegular(
                  path.join(output, "terminal-capture.json"),
                  "terminal capture",
                ),
              ),
            },
          }
        : {}),
      ...(normalized.renditionSet
        ? {
            renditionSet: {
              schema: normalized.renditionSet.schema,
              root: sha256(
                readRegular(
                  path.join(output, "rendition-set.json"),
                  "rendition set",
                ),
              ),
              renditions: renditionInputRoots(
                output,
                normalized.renditionSet.renditions,
              ),
            },
          }
        : {}),
      evidenceClass: normalized.projection.evidenceClass,
      claimBoundary: normalized.projection.claimBoundary,
    },
  });
  const root = writeChecksums(output);
  const artifactName = `auditable-demo-gate-${sourceSha.slice(0, 12)}-${root.slice(7, 23)}`;
  return { status: "passed", root, artifactName };
}

export function verifyGate(request) {
  const bundle = path.resolve(required(request, "bundle"));
  const expectedRoot = required(request, "expectedRoot");
  const expectedImage = required(request, "rendererImage");
  const expectedSourceSha = required(request, "sourceSha");
  const expectedMediaProfile = request["mediaProfile"] || "archive-v1";
  invariant(
    DIGEST_PATTERN.test(expectedRoot),
    "expected gate root must be sha256",
  );
  invariant(
    verifyChecksums(bundle) === expectedRoot,
    "gate bundle root mismatch",
  );
  const receipt = readJson(
    path.join(bundle, "gate-receipt.json"),
    "gate receipt",
  );
  invariant(
    receipt.schema === "buildchain.auditable-demo-gate/v1" &&
      receipt.status === "passed",
    "gate did not pass",
  );
  invariant(
    receipt.sourceSha === expectedSourceSha,
    "gate source SHA mismatch",
  );
  invariant(
    receipt.renderer?.image === expectedImage,
    "gate renderer image mismatch",
  );
  invariant(
    receipt.renderer?.mediaProfile === expectedMediaProfile,
    "gate media profile mismatch",
  );
  invariant(
    DIGEST_PATTERN.test(receipt.renderer?.mediaQualificationRoot || ""),
    "gate media qualification root is invalid",
  );
  const normalized = validateAdapterOutput(bundle, false);
  invariant(
    receipt.qualifiedInputs?.transcript ===
      sha256(
        readRegular(path.join(bundle, "complete-transcript.txt"), "transcript"),
      ) &&
      receipt.qualifiedInputs?.projection ===
        sha256(
          readRegular(
            path.join(bundle, "public-projection.json"),
            "projection",
          ),
        ) &&
      receipt.qualifiedInputs?.scene ===
        sha256(readRegular(path.join(bundle, "scene.json"), "scene")),
    "gate qualified input roots mismatch",
  );
  const qualifiedCapture = receipt.qualifiedInputs?.terminalCapture;
  invariant(
    Boolean(qualifiedCapture) === Boolean(normalized.terminalCapture),
    "gate terminal capture presence drifted",
  );
  if (normalized.terminalCapture) {
    invariant(
      qualifiedCapture.schema === normalized.terminalCapture.schema &&
        qualifiedCapture.root ===
          sha256(
            readRegular(
              path.join(bundle, "terminal-capture.json"),
              "terminal capture",
            ),
          ),
      "gate terminal capture root mismatch",
    );
  }
  const qualifiedRenditionSet = receipt.qualifiedInputs?.renditionSet;
  invariant(
    Boolean(qualifiedRenditionSet) === Boolean(normalized.renditionSet),
    "gate rendition set presence drifted",
  );
  if (normalized.renditionSet) {
    invariant(
      qualifiedRenditionSet.schema === normalized.renditionSet.schema &&
        qualifiedRenditionSet.root ===
          sha256(
            readRegular(
              path.join(bundle, "rendition-set.json"),
              "rendition set",
            ),
          ) &&
        stableJson(qualifiedRenditionSet.renditions) ===
          stableJson(
            renditionInputRoots(bundle, normalized.renditionSet.renditions),
          ),
      "gate native rendition roots mismatch",
    );
  }
  invariant(
    receipt.qualifiedInputs.evidenceClass ===
      normalized.projection.evidenceClass,
    "gate evidence class drifted",
  );
}
