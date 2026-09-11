import { validateRenditionSet, validateTerminalCapture } from "./renditions.js";
import path from "node:path";
const PRESENTATION_FRAMED = "presentation-framed";
const TERMINAL_FILL = "terminal-fill";
const GEOMETRY_TOLERANCE = 0.001;

function closeEnough(left, right, tolerance = GEOMETRY_TOLERANCE) {
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= tolerance
  );
}

function validateContentViewport(
  composition,
  expected,
  expectedMode,
  label,
  helpers,
) {
  const { exactKeys, invariant } = helpers;
  const viewport = composition.contentViewport;
  exactKeys(
    viewport,
    ["x", "y", "width", "height", "fillRatio"],
    [],
    `${label}.contentViewport`,
  );
  invariant(
    [
      viewport.x,
      viewport.y,
      viewport.width,
      viewport.height,
      viewport.fillRatio,
    ].every(Number.isFinite),
    `${label} content viewport is malformed or out of bounds`,
  );
  invariant(
    viewport.x >= 0 &&
      viewport.y >= 0 &&
      viewport.width > 0 &&
      viewport.height > 0,
    `${label} content viewport is malformed or out of bounds`,
  );
  invariant(
    viewport.x + viewport.width <= expected.width + GEOMETRY_TOLERANCE &&
      viewport.y + viewport.height <= expected.height + GEOMETRY_TOLERANCE,
    `${label} content viewport is malformed or out of bounds`,
  );
  invariant(
    viewport.fillRatio > 0 &&
      viewport.fillRatio <= 1 &&
      closeEnough(
        viewport.fillRatio,
        (viewport.width * viewport.height) / (expected.width * expected.height),
        0.000001,
      ),
    `${label} content viewport is malformed or out of bounds`,
  );
  if (expectedMode === TERMINAL_FILL) {
    invariant(
      closeEnough(viewport.x, 0) &&
        closeEnough(viewport.y, 0) &&
        closeEnough(viewport.width, expected.width) &&
        closeEnough(viewport.height, expected.height) &&
        closeEnough(viewport.fillRatio, 1, 0.000001),
      `${label} does not provide a full-frame terminal viewport`,
    );
  }
}

function validateTerminalGeometry(
  composition,
  expected,
  expectedMode,
  label,
  helpers,
) {
  const { exactKeys, invariant } = helpers;
  const geometry = composition.terminalGeometry;
  if (expected.columns == null || expected.rows == null) {
    invariant(
      geometry === null,
      `${label} unexpectedly declares terminal cell geometry`,
    );
    return;
  }
  exactKeys(
    geometry,
    [
      "columns",
      "rows",
      "cellWidth",
      "cellHeight",
      "fontSize",
      "lineHeight",
      "layout",
    ],
    [],
    `${label}.terminalGeometry`,
  );
  invariant(
    geometry.columns === expected.columns && geometry.rows === expected.rows,
    `${label} terminal cell geometry is malformed or rendition-mismatched`,
  );
  invariant(
    [
      geometry.cellWidth,
      geometry.cellHeight,
      geometry.fontSize,
      geometry.lineHeight,
    ].every((value) => Number.isFinite(value) && value > 0),
    `${label} terminal cell geometry is malformed or rendition-mismatched`,
  );
  invariant(
    geometry.layout ===
      (expectedMode === TERMINAL_FILL ? "exact-grid" : "presentation-flow"),
    `${label} terminal cell geometry is malformed or rendition-mismatched`,
  );
  if (expectedMode === TERMINAL_FILL) {
    invariant(
      closeEnough(geometry.cellWidth * geometry.columns, expected.width) &&
        closeEnough(geometry.cellHeight * geometry.rows, expected.height) &&
        closeEnough(geometry.lineHeight, geometry.cellHeight),
      `${label} terminal cell geometry does not resolve to the full frame`,
    );
  }
}

function validateCompositionFrameSet(
  frameSet,
  expected,
  expectedMode,
  multiple,
  index,
  helpers,
) {
  const { exactKeys, invariant } = helpers;
  const label = `renderer composition frame set ${index}`;
  invariant(frameSet && typeof frameSet === "object", `${label} is missing`);
  invariant(
    multiple
      ? frameSet.id === expected.id &&
          frameSet.role === expected.role &&
          frameSet.width === expected.width &&
          frameSet.height === expected.height
      : frameSet.width === expected.width &&
          frameSet.height === expected.height,
    multiple
      ? `${label} does not match the requested rendition`
      : `${label} dimensions do not match the requested scene`,
  );
  const composition = frameSet.composition;
  exactKeys(
    composition,
    ["mode", "contentViewport", "terminalGeometry"],
    [],
    `${label}.composition`,
  );
  invariant(
    composition.mode === expectedMode,
    `${label} mode drifted from the requested scene`,
  );
  validateContentViewport(composition, expected, expectedMode, label, helpers);
  validateTerminalGeometry(composition, expected, expectedMode, label, helpers);
  return composition;
}

export function validateRendererComposition(manifest, renditions, helpers) {
  const { exactKeys, invariant } = helpers;
  invariant(
    Array.isArray(renditions) && renditions.length >= 1,
    "renderer composition requires declared renditions",
  );
  const expectedMode = renditions[0].compositionMode ?? PRESENTATION_FRAMED;
  invariant(
    (expectedMode === PRESENTATION_FRAMED || expectedMode === TERMINAL_FILL) &&
      renditions.every(
        (entry) =>
          (entry.compositionMode ?? PRESENTATION_FRAMED) === expectedMode,
      ),
    "requested rendition composition modes do not match",
  );
  const version = String(manifest.renderer?.contractVersion || "")
    .split(".")
    .map(Number);
  invariant(
    version.length === 3 && version.every(Number.isInteger) && version[0] === 1,
    "renderer contract version is unsupported",
  );
  const supportsCompositionEvidence = version[1] >= 4;
  if (!supportsCompositionEvidence) {
    invariant(
      expectedMode === PRESENTATION_FRAMED,
      "renderer contract does not support composition evidence",
    );
    const sourceFrames = manifest.derivation?.sourceFrames;
    const frameSets = manifest.derivation?.sourceFrameSets;
    invariant(
      manifest.policy?.compositionMode === undefined &&
        sourceFrames?.composition === undefined &&
        (!Array.isArray(frameSets) ||
          frameSets.every((entry) => entry?.composition === undefined)),
      "legacy renderer contract cannot declare composition evidence",
    );
    return {
      mode: expectedMode,
      frameSets: [],
      evidence: "legacy-presentation-default",
    };
  }
  invariant(
    manifest.policy?.compositionMode === expectedMode,
    "renderer composition policy drifted from the requested scene",
  );
  const sourceFrames = manifest.derivation?.sourceFrames;
  const frameSets =
    renditions.length === 1
      ? [sourceFrames]
      : manifest.derivation?.sourceFrameSets;
  invariant(
    Array.isArray(frameSets) && frameSets.length === renditions.length,
    "renderer composition frame-set evidence is missing",
  );
  const compositions = frameSets.map((frameSet, index) =>
    validateCompositionFrameSet(
      frameSet,
      renditions[index],
      expectedMode,
      renditions.length > 1,
      index,
      helpers,
    ),
  );
  if (renditions.length > 1) {
    invariant(
      JSON.stringify(sourceFrames?.composition) ===
        JSON.stringify(frameSets[0].composition),
      "renderer primary composition evidence drifted between sourceFrames and sourceFrameSets",
    );
  }
  return { mode: expectedMode, frameSets: compositions };
}

export function rendererCompositionRenditions(
  expectedInputs,
  primaryScene,
  helpers,
) {
  const { invariant, readJson } = helpers;
  if (expectedInputs.renditionSet) {
    const set = validateRenditionSet(
      path.dirname(expectedInputs.renditionSet),
      helpers,
    );
    invariant(set, "renderer expected rendition set is missing");
    return set.renditions.map((rendition) => ({
      id: rendition.id,
      role: rendition.role,
      width: rendition.scene.width,
      height: rendition.scene.height,
      columns: rendition.capture.dimensions.columns,
      rows: rendition.capture.dimensions.rows,
      compositionMode: rendition.scene.compositionMode,
    }));
  }
  const terminal = expectedInputs.terminalCapture
    ? validateTerminalCapture(
        readJson(
          expectedInputs.terminalCapture,
          "renderer expected terminal capture",
        ),
        primaryScene,
        helpers,
      )
    : null;
  return [
    {
      width: primaryScene.width,
      height: primaryScene.height,
      columns: terminal?.dimensions.columns ?? null,
      rows: terminal?.dimensions.rows ?? null,
      compositionMode: primaryScene.compositionMode,
    },
  ];
}

export function validateRendererCompositionInputs(
  manifest,
  expectedInputs,
  helpers,
) {
  const { invariant, readJson, validateScene } = helpers;
  if (expectedInputs.renditionSet) {
    invariant(
      manifest.derivation?.policy === "independent-native-frame-sets/v1",
      "renderer did not use independent native frame sets",
    );
    invariant(
      Array.isArray(manifest.inputs?.renditions) &&
        manifest.inputs.renditions.length === 2 &&
        manifest.inputs.renditions[0]?.role === "primary" &&
        manifest.inputs.renditions[1]?.role === "responsive" &&
        manifest.inputs.renditions[0]?.terminalCapture?.root !==
          manifest.inputs.renditions[1]?.terminalCapture?.root,
      "renderer native rendition inputs are not independently bound",
    );
  }
  const primaryScene = validateScene(
    readJson(expectedInputs.scene, "renderer expected scene"),
  );
  return validateRendererComposition(
    manifest,
    rendererCompositionRenditions(expectedInputs, primaryScene, helpers),
    helpers,
  );
}
