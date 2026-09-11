import fs from "node:fs";
import path from "node:path";
import {
  SAFE_ID,
  SAFE_MARKER,
  NON_AUTHORITIES,
  RENDITIONS,
  STANDARD_MAX_SECONDS,
  PRESENTATION_FRAMED,
  TERMINAL_FILL,
  MAX_EXECUTABLE_FILES,
  durationPolicy,
  requireValue,
  stableJson,
  rootBytes,
  rootJson,
  regular,
  readJson,
  inside,
  exactKeys,
} from "./values.js";
import { validateDemoPresentation } from "./presentation.js";
function validateProduct(product) {
  exactKeys(
    product,
    ["id", "displayName", "binaryName"],
    [],
    "scenario.product",
  );
  requireValue(SAFE_ID.test(product.id), "scenario.product.id is invalid");
  requireValue(
    typeof product.displayName === "string" &&
      product.displayName.length > 0 &&
      product.displayName.length <= 80,
    "scenario.product.displayName is invalid",
  );
  requireValue(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(product.binaryName),
    "scenario.product.binaryName is invalid",
  );
}

function validateArtifact(artifact) {
  exactKeys(
    artifact,
    [
      "platformId",
      "binaryPath",
      "metadataPath",
      "metadataContract",
      "runtimeDependencies",
    ],
    [],
    "scenario.artifact",
  );
  requireValue(
    artifact.platformId === "linux-x64",
    "scenario artifact must be linux-x64",
  );
  for (const key of ["binaryPath", "metadataPath"])
    inside("/scenario-root", artifact[key], `scenario.artifact.${key}`);
  requireValue(
    typeof artifact.metadataContract === "string" &&
      artifact.metadataContract.length > 0,
    "scenario artifact metadataContract is invalid",
  );
  requireValue(
    Array.isArray(artifact.runtimeDependencies) &&
      artifact.runtimeDependencies.length === 0,
    "scenario artifact must be standalone",
  );
}

function validateTransportSmoke(smoke) {
  exactKeys(
    smoke,
    ["argv", "timeoutSeconds", "expectedExitCodes", "stdoutIncludes"],
    [],
    "scenario.transportSmoke",
  );
  requireValue(
    Array.isArray(smoke.argv) &&
      smoke.argv.length >= 1 &&
      smoke.argv.length <= 64 &&
      smoke.argv.every(
        (item) =>
          typeof item === "string" &&
          !item.includes("\0") &&
          item.length <= 512,
      ),
    "scenario transport smoke argv is invalid",
  );
  requireValue(
    Number.isInteger(smoke.timeoutSeconds) &&
      smoke.timeoutSeconds >= 1 &&
      smoke.timeoutSeconds <= STANDARD_MAX_SECONDS,
    "scenario transport smoke timeout is invalid",
  );
  requireValue(
    Array.isArray(smoke.expectedExitCodes) &&
      smoke.expectedExitCodes.length >= 1 &&
      smoke.expectedExitCodes.length <= 4 &&
      smoke.expectedExitCodes.every(
        (item) => Number.isInteger(item) && item >= 0 && item <= 255,
      ),
    "scenario transport smoke expected exits are invalid",
  );
  requireValue(
    Array.isArray(smoke.stdoutIncludes) &&
      smoke.stdoutIncludes.length <= 32 &&
      smoke.stdoutIncludes.every(
        (item) =>
          typeof item === "string" && item.length >= 1 && item.length <= 256,
      ),
    "scenario transport smoke stdout assertions are invalid",
  );
}

function validateExecutableClosure({
  artifactRoot,
  scenario,
  requireExecutable,
}) {
  const root = path.resolve(artifactRoot);
  const artifact = scenario.artifact;
  const metadata = readJson(
    inside(root, artifact.metadataPath, "artifact metadata path"),
    "binary metadata",
  );
  requireValue(
    metadata.contract === artifact.metadataContract,
    "binary metadata contract mismatch",
  );
  requireValue(
    (metadata.platformId || metadata.platform) === artifact.platformId,
    "binary metadata platform mismatch",
  );
  requireValue(
    JSON.stringify(metadata.runtimeDependencies) ===
      JSON.stringify(artifact.runtimeDependencies),
    "binary metadata runtime dependency mismatch",
  );
  requireValue(
    Array.isArray(metadata.executableFiles) &&
      metadata.executableFiles.length >= 1 &&
      metadata.executableFiles.length <= MAX_EXECUTABLE_FILES,
    "binary metadata executableFiles must be a bounded non-empty array",
  );
  const declared = new Set();
  const files = metadata.executableFiles.map((entry, index) => {
    const label = `binary metadata executableFiles[${index}]`;
    exactKeys(entry, ["path", "sha256"], [], label);
    requireValue(!declared.has(entry.path), `${label}.path is repeated`);
    declared.add(entry.path);
    requireValue(
      /^[0-9a-f]{64}$/u.test(entry.sha256),
      `${label}.sha256 is invalid`,
    );
    const file = inside(root, entry.path, `${label}.path`);
    const bytes = regular(file, label, 256 * 1024 * 1024);
    requireValue(
      rootBytes(bytes) === `sha256:${entry.sha256}`,
      `${label} digest differs from exact artifact metadata`,
    );
    if (requireExecutable)
      requireValue(
        (fs.statSync(file).mode & 0o111) !== 0,
        `${label} is not executable`,
      );
    return { path: entry.path, file, sha256: entry.sha256 };
  });
  requireValue(
    declared.has(artifact.binaryPath),
    "binary metadata executableFiles must include scenario.artifact.binaryPath",
  );
  const binary = files.find((entry) => entry.path === artifact.binaryPath);
  const metadataBinarySha256 = String(metadata.sha256 || "").replace(
    /^sha256:/u,
    "",
  );
  requireValue(
    /^[0-9a-f]{64}$/u.test(metadataBinarySha256) &&
      metadataBinarySha256 === binary.sha256,
    "binary digest differs from exact artifact metadata",
  );
  return { metadata, files };
}

export function prepareArtifact({ artifactRoot, scenarioPath }) {
  const scenario = validateScenario(
    readJson(path.resolve(scenarioPath), "scenario"),
  );
  const closure = validateExecutableClosure({
    artifactRoot,
    scenario,
    requireExecutable: false,
  });
  for (const entry of closure.files) fs.chmodSync(entry.file, 0o755);
  validateExecutableClosure({
    artifactRoot,
    scenario,
    requireExecutable: true,
  });
  return {
    executableFiles: closure.files.map(({ path: relative, sha256 }) => ({
      path: relative,
      sha256,
    })),
    metadataRoot: rootJson(closure.metadata),
    authority: {
      classification: "artifact-mode-restoration",
      grants: [],
      nonAuthorities: NON_AUTHORITIES,
    },
  };
}

function validateExecution(execution) {
  exactKeys(
    execution,
    [
      "deterministic",
      "network",
      "secrets",
      "totalTimeoutSeconds",
      "environment",
    ],
    ["durationClass"],
    "scenario.execution",
  );
  requireValue(
    execution.deterministic === true &&
      execution.network === "none" &&
      execution.secrets === "none",
    "scenario execution must be deterministic, network-disabled, and secret-free",
  );
  const policy = durationPolicy(execution.durationClass);
  requireValue(
    Number.isInteger(execution.totalTimeoutSeconds) &&
      execution.totalTimeoutSeconds >= 1 &&
      execution.totalTimeoutSeconds <= policy.maximumSeconds,
    "scenario total timeout is invalid",
  );
  requireValue(
    execution.environment &&
      typeof execution.environment === "object" &&
      !Array.isArray(execution.environment),
    "scenario environment must be an object",
  );
  for (const [key, item] of Object.entries(execution.environment)) {
    requireValue(
      /^[A-Z][A-Z0-9_]{0,63}$/u.test(key) &&
        typeof item === "string" &&
        item.length <= 256,
      `scenario environment entry is invalid: ${key}`,
    );
  }
  return policy;
}

function validatePlayback(playback, maximumSeconds) {
  exactKeys(
    playback,
    ["schema", "mode", "activeDurationMs", "finalHoldMs"],
    [],
    "scenario.playback",
  );
  requireValue(
    playback.schema === "buildchain.declarative-demo-playback/v1",
    "scenario playback schema is unsupported",
  );
  requireValue(
    playback.mode === "deterministic-readable",
    "scenario playback mode is invalid",
  );
  requireValue(
    Number.isInteger(playback.activeDurationMs) &&
      playback.activeDurationMs >= 1000,
    "scenario playback active duration is invalid",
  );
  requireValue(
    Number.isInteger(playback.finalHoldMs) &&
      playback.finalHoldMs >= 250 &&
      playback.finalHoldMs <= 5000,
    "scenario playback final hold is invalid",
  );
  requireValue(
    playback.activeDurationMs + playback.finalHoldMs <= maximumSeconds * 1000,
    "scenario playback exceeds its declared duration class",
  );
  return playback;
}

function validateStep(step, stepLabel, stepIds, maximumSeconds) {
  exactKeys(
    step,
    [
      "id",
      "argv",
      "timeoutSeconds",
      "expectedExitCodes",
      "stdoutIncludes",
      "fileAssertions",
    ],
    [],
    stepLabel,
  );
  requireValue(
    SAFE_ID.test(step.id) && !stepIds.has(step.id),
    `${stepLabel}.id is invalid or repeated`,
  );
  stepIds.add(step.id);
  requireValue(
    Array.isArray(step.argv) &&
      step.argv.length >= 1 &&
      step.argv.length <= 64 &&
      step.argv.every(
        (item) =>
          typeof item === "string" &&
          !item.includes("\0") &&
          item.length <= 512,
      ),
    `${stepLabel}.argv is invalid`,
  );
  requireValue(
    !Object.hasOwn(step, "command"),
    `${stepLabel} must not use a shell command string`,
  );
  requireValue(
    Number.isInteger(step.timeoutSeconds) &&
      step.timeoutSeconds >= 1 &&
      step.timeoutSeconds <= maximumSeconds,
    `${stepLabel}.timeoutSeconds is invalid`,
  );
  requireValue(
    Array.isArray(step.expectedExitCodes) &&
      step.expectedExitCodes.length >= 1 &&
      step.expectedExitCodes.length <= 4 &&
      step.expectedExitCodes.every(
        (item) => Number.isInteger(item) && item >= 0 && item <= 255,
      ),
    `${stepLabel}.expectedExitCodes is invalid`,
  );
  requireValue(
    Array.isArray(step.stdoutIncludes) &&
      step.stdoutIncludes.every(
        (item) =>
          typeof item === "string" && item.length >= 1 && item.length <= 256,
      ),
    `${stepLabel}.stdoutIncludes is invalid`,
  );
  requireValue(
    Array.isArray(step.fileAssertions) && step.fileAssertions.length <= 32,
    `${stepLabel}.fileAssertions is invalid`,
  );
  for (const assertion of step.fileAssertions) {
    exactKeys(
      assertion,
      ["path", "jsonEquals"],
      [],
      `${stepLabel}.fileAssertions[]`,
    );
    inside("/workspace", assertion.path, `${stepLabel} assertion path`);
    requireValue(
      assertion.jsonEquals &&
        typeof assertion.jsonEquals === "object" &&
        !Array.isArray(assertion.jsonEquals),
      `${stepLabel} jsonEquals is invalid`,
    );
  }
}

function validateDemo(demo, index, demoIds, maximumSeconds) {
  const label = `scenario.demos[${index}]`;
  exactKeys(demo, ["id", "title", "claimBoundary", "steps"], [], label);
  requireValue(
    SAFE_ID.test(demo.id) && !demoIds.has(demo.id),
    `${label}.id is invalid or repeated`,
  );
  demoIds.add(demo.id);
  requireValue(
    typeof demo.title === "string" &&
      demo.title.length > 0 &&
      demo.title.length <= 120,
    `${label}.title is invalid`,
  );
  requireValue(
    typeof demo.claimBoundary === "string" &&
      demo.claimBoundary.length > 0 &&
      demo.claimBoundary.length <= 500,
    `${label}.claimBoundary is invalid`,
  );
  requireValue(
    Array.isArray(demo.steps) &&
      demo.steps.length >= 1 &&
      demo.steps.length <= 12,
    `${label}.steps is invalid`,
  );
  const stepIds = new Set();
  demo.steps.forEach((step, stepIndex) =>
    validateStep(step, `${label}.steps[${stepIndex}]`, stepIds, maximumSeconds),
  );
}

export function validateScenario(value) {
  exactKeys(
    value,
    [
      "schema",
      "product",
      "artifact",
      "execution",
      "renditions",
      "demos",
      "publication",
      "authority",
    ],
    ["compositionMode", "playback", "transportSmoke", "presentation"],
    "scenario",
  );
  requireValue(
    value.schema === "buildchain.declarative-binary-demo/v1",
    "unsupported scenario schema",
  );
  const compositionMode = value.compositionMode ?? PRESENTATION_FRAMED;
  requireValue(
    compositionMode === PRESENTATION_FRAMED ||
      compositionMode === TERMINAL_FILL,
    "scenario composition mode is invalid",
  );
  validateProduct(value.product);
  validateArtifact(value.artifact);
  const executionPolicy = validateExecution(value.execution);
  if (value.playback)
    validatePlayback(value.playback, executionPolicy.maximumSeconds);
  requireValue(
    stableJson(value.renditions) === stableJson(RENDITIONS),
    "scenario must declare both native rendition profiles exactly",
  );
  requireValue(
    Array.isArray(value.demos) &&
      value.demos.length >= 1 &&
      value.demos.length <= 8,
    "scenario requires 1 through 8 demos",
  );
  const demoIds = new Set();
  value.demos.forEach((demo, index) =>
    validateDemo(demo, index, demoIds, executionPolicy.maximumSeconds),
  );
  if (value.transportSmoke) validateTransportSmoke(value.transportSmoke);
  exactKeys(
    value.publication,
    ["evidencePath", "readmePath", "marker"],
    [],
    "scenario.publication",
  );
  inside(
    "/repository",
    value.publication.evidencePath,
    "scenario.publication.evidencePath",
  );
  inside(
    "/repository",
    value.publication.readmePath,
    "scenario.publication.readmePath",
  );
  requireValue(
    SAFE_MARKER.test(value.publication.marker),
    "scenario publication marker is invalid",
  );
  if (value.presentation)
    validateDemoPresentation({
      presentation: value.presentation,
      demos: value.demos,
      publication: value.publication,
      exactKeys,
      inside,
      requireValue,
      safeMarker: SAFE_MARKER,
    });
  exactKeys(
    value.authority,
    ["grants", "nonAuthorities"],
    [],
    "scenario.authority",
  );
  requireValue(
    JSON.stringify(value.authority) ===
      JSON.stringify({ grants: [], nonAuthorities: NON_AUTHORITIES }),
    "scenario authority boundary is invalid",
  );
  return value;
}
