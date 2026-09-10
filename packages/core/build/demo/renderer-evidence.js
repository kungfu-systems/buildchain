import {
  IMAGE_PATTERN,
  MAX_BUNDLE_MEMBER_BYTES,
  invariant,
  sha256,
  readRegular,
  readJson,
  writeJson,
  resolveInside,
  listFiles,
  verifyChecksums,
  required,
  semanticRoot,
} from "./io.js";
import { RENDITION_VALIDATION_HELPERS } from "./schema.js";
import { qualifyRendererOutput } from "./media-profile.js";
import { inspectMediaFile, loadMediaInspection } from "./media-inspection.js";
import fs from "node:fs";
import path from "node:path";
import { readRendererManifest } from "./renditions.js";
import { validateRendererCompositionInputs } from "./composition.js";

export function qualifyMediaFixture(request) {
  const renderOutput = path.resolve(required(request, "renderOutput"));
  const output = path.resolve(required(request, "output"));
  const rendererImage = required(request, "rendererImage");
  const rendererSourceRepository = required(
    request,
    "rendererSourceRepository",
  );
  const rendererSourceRef = required(request, "rendererSourceRef");
  const rendererSourceSha = required(request, "rendererSourceSha");
  const mediaProfile = required(request, "mediaProfile");
  invariant(
    IMAGE_PATTERN.test(rendererImage),
    "renderer image must use an immutable sha256 coordinate",
  );
  invariant(
    /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(rendererSourceRepository),
    "renderer source repository is invalid",
  );
  invariant(
    /^refs\/tags\/[a-zA-Z0-9._-]+$/.test(rendererSourceRef),
    "renderer source ref must be an exact tag ref",
  );
  invariant(
    /^[0-9a-f]{40}$/.test(rendererSourceSha),
    "renderer source SHA must be exact",
  );
  invariant(
    !fs.existsSync(output),
    "media fixture evidence output must not already exist",
  );
  const mediaInspection = loadMediaInspection(
    path.resolve(required(request, "mediaInspection")),
    renderOutput,
    rendererImage,
  );
  const verified = verifyRendererOutput(
    renderOutput,
    rendererImage,
    {
      scene: path.join(renderOutput, "scene.json"),
      transcript: path.join(renderOutput, "complete-transcript.txt"),
      projection: path.join(renderOutput, "public-projection.json"),
    },
    {
      mediaProfile,
      inspectMedia: mediaInspection.inspectMedia,
      inspectionRoot: mediaInspection.inspectionRoot,
    },
  );
  const body = {
    schema: "buildchain.auditable-demo-media-profile-fixture/v1",
    renderer: {
      image: rendererImage,
      sourceRepository: rendererSourceRepository,
      sourceRef: rendererSourceRef,
      sourceSha: rendererSourceSha,
    },
    inputs: Object.fromEntries(
      ["complete-transcript.txt", "public-projection.json", "scene.json"].map(
        (name) => [
          name,
          sha256(readRegular(path.join(renderOutput, name), `fixture ${name}`)),
        ],
      ),
    ),
    rendererManifestRoot: sha256(
      readRendererManifest(
        path.join(renderOutput, "manifest.json"),
        RENDITION_VALIDATION_HELPERS,
      ).bytes,
    ),
    qualification: verified.qualification,
  };
  const evidence = { ...body, evidenceRoot: semanticRoot(body) };
  writeJson(output, evidence);
  return evidence;
}

export function verifyRendererOutput(
  renderOutput,
  expectedImage,
  expectedInputs,
  options = {},
) {
  invariant(
    IMAGE_PATTERN.test(expectedImage),
    "renderer image must use an immutable sha256 coordinate",
  );
  const fixedMembers = [
    "checksums.sha256",
    "complete-transcript.txt",
    "manifest.json",
    "public-projection.json",
    "scene.json",
  ];
  verifyChecksums(renderOutput, "checksums.sha256", {
    allowLongFormRendererManifest: true,
  });
  const { manifest } = readRendererManifest(
    path.join(renderOutput, "manifest.json"),
    RENDITION_VALIDATION_HELPERS,
  );
  invariant(
    manifest.renderer?.image === expectedImage,
    "renderer manifest image coordinate mismatch",
  );
  const outputNames = Object.keys(manifest.outputs || {}).sort();
  invariant(
    outputNames.includes("media-probe.json"),
    "renderer manifest must declare media-probe.json",
  );
  const expectedMembers = [
    ...new Set([...fixedMembers, ...outputNames]),
  ].sort();
  invariant(
    JSON.stringify(listFiles(renderOutput)) === JSON.stringify(expectedMembers),
    "renderer output member set is not exact",
  );
  for (const name of outputNames) {
    invariant(
      !name.includes("\\") && !name.split("/").includes(".."),
      `renderer output path is invalid: ${name}`,
    );
    const target = resolveInside(
      renderOutput,
      name,
      "renderer manifest output",
    );
    const bytes = readRegular(target, name, MAX_BUNDLE_MEMBER_BYTES);
    const declared = manifest.outputs[name];
    invariant(
      declared?.root === sha256(bytes),
      `renderer manifest root mismatch: ${name}`,
    );
    invariant(
      declared?.bytes === bytes.length,
      `renderer manifest byte count mismatch: ${name}`,
    );
  }
  for (const [key, filePath] of Object.entries(expectedInputs)) {
    const observed = manifest.inputs?.[key]?.root;
    invariant(
      observed === sha256(readRegular(filePath, `${key} input`)),
      `renderer ${key} input root mismatch`,
    );
  }
  const composition = validateRendererCompositionInputs(
    manifest,
    expectedInputs,
    RENDITION_VALIDATION_HELPERS,
  );
  const probe = readJson(
    path.join(renderOutput, "media-probe.json"),
    "media probe",
  );
  invariant(
    probe.schema === "build-images.demo-media-probe/v1" &&
      probe.passed === true,
    "renderer media probe failed",
  );
  const qualification = qualifyRendererOutput(
    renderOutput,
    manifest,
    readJson(path.join(renderOutput, "scene.json"), "renderer scene"),
    options.mediaProfile || "archive-v1",
    options.inspectMedia || inspectMediaFile,
    options.inspectionRoot || "",
  );
  return { manifest, probe, qualification, composition };
}
