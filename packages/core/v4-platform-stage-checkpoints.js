import fs from "node:fs";
import path from "node:path";

import {
  V4ContractFault,
  v4CanonicalBytes,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";
import {
  V4_STAGE_CAPSULE_CONTRACT,
  V4_STAGE_CAPSULE_IDENTITY_CONTRACT,
  v4StageCapsuleIdentityRoot,
  v4StageCapsuleRoot,
  validateV4StageCapsule,
} from "./v4-stage-capsule.js";
import {
  V4_STAGE_CAPSULE_OUTPUT_MANIFEST_CONTRACT,
  v4StageCapsuleBlobRoot,
  v4StageCapsuleOutputManifestRoot,
} from "./v4-stage-capsule-store.js";

export const V4_PLATFORM_STAGE_CHECKPOINT_CONTRACT =
  "buildchain-v4-platform-stage-checkpoint/v1";
export const V4_PLATFORM_STAGE_RESTORE_CONTRACT =
  "buildchain-v4-platform-stage-restore/v1";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const ZERO_ROOT = `sha256:${"0".repeat(64)}`;

function fault(code, location, message) {
  throw new V4ContractFault(code, location, message);
}

function object(value, location) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("invalid-stage-checkpoint-shape", location, "object required");
  return value;
}

function exactKeys(value, expected, location) {
  object(value, location);
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  )
    fault(
      "undeclared-stage-checkpoint-field",
      location,
      `${location} keys do not match the declaration`,
    );
}

function tokens(values, location) {
  if (!Array.isArray(values))
    fault("invalid-stage-checkpoint-shape", location, "array required");
  let prior = null;
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || !TOKEN.test(value))
      fault(
        "invalid-stage-checkpoint-token",
        `${location}/${index}`,
        "token required",
      );
    if (prior !== null && value <= prior)
      fault(
        "unordered-stage-checkpoint-declaration",
        `${location}/${index}`,
        "tokens must be unique and byte-sorted",
      );
    prior = value;
  }
  return values;
}

function rootOf(value) {
  return v4StageCapsuleBlobRoot(v4CanonicalBytes(value));
}

function declaredMap(value, names, location, { roots = false } = {}) {
  exactKeys(value, names, location);
  return names.map((name) => {
    const entry = value[name];
    if (roots) validateV4Root(entry, `${location}/${name}`);
    else if (typeof entry !== "string")
      fault(
        "invalid-stage-checkpoint-value",
        `${location}/${name}`,
        "string required",
      );
    return { name, root: roots ? entry : rootOf(entry) };
  });
}

function safeRelative(relativePath, location) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    fault(
      "unsafe-stage-checkpoint-path",
      location,
      "declared output path must be a portable relative path",
    );
  return relativePath;
}

export function validateV4PlatformStageCheckpointDeclaration(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "contract",
      "capsuleAuthority",
      "storeAuthority",
      "mode",
      "platforms",
      "stages",
      "projections",
      "authority",
    ],
    "$/declaration",
  );
  if (
    value.schemaVersion !== 1 ||
    value.contract !== "kungfu-buildchain-v4-platform-stage-checkpoints" ||
    value.mode !== "shadow-only"
  )
    fault(
      "unsupported-stage-checkpoint-declaration",
      "$/declaration",
      "unsupported checkpoint declaration",
    );
  if (!Array.isArray(value.platforms) || value.platforms.length !== 3)
    fault(
      "invalid-stage-checkpoint-platforms",
      "$/declaration/platforms",
      "three platforms required",
    );
  const platformIds = [];
  for (const [index, platform] of value.platforms.entries()) {
    exactKeys(
      platform,
      ["id", "os", "arch", "runner"],
      `$/declaration/platforms/${index}`,
    );
    for (const key of ["id", "os", "arch"])
      if (typeof platform[key] !== "string" || !TOKEN.test(platform[key]))
        fault(
          "invalid-stage-checkpoint-token",
          `$/declaration/platforms/${index}/${key}`,
          "token required",
        );
    if (typeof platform.runner !== "string" || platform.runner.length === 0)
      fault(
        "invalid-stage-checkpoint-value",
        `$/declaration/platforms/${index}/runner`,
        "runner required",
      );
    platformIds.push(platform.id);
  }
  tokens([...platformIds].sort(), "$/declaration/platformIds");
  if (!Array.isArray(value.stages) || value.stages.length === 0)
    fault(
      "invalid-stage-checkpoint-stages",
      "$/declaration/stages",
      "stages required",
    );
  const stageIds = [];
  for (const [index, stage] of value.stages.entries()) {
    const location = `$/declaration/stages/${index}`;
    exactKeys(
      stage,
      [
        "id",
        "inputs",
        "outputs",
        "environment",
        "toolchains",
        "providerEffects",
      ],
      location,
    );
    if (
      typeof stage.id !== "string" ||
      !TOKEN.test(stage.id) ||
      stage.providerEffects !== false
    )
      fault(
        "invalid-stage-checkpoint-stage",
        location,
        "stage id and effect boundary are invalid",
      );
    tokens(stage.inputs, `${location}/inputs`);
    tokens(stage.environment, `${location}/environment`);
    tokens(stage.toolchains, `${location}/toolchains`);
    if (!Array.isArray(stage.outputs) || stage.outputs.length === 0)
      fault(
        "invalid-stage-checkpoint-outputs",
        `${location}/outputs`,
        "outputs required",
      );
    const outputNames = [];
    for (const [outputIndex, output] of stage.outputs.entries()) {
      exactKeys(output, ["name", "path"], `${location}/outputs/${outputIndex}`);
      if (typeof output.name !== "string" || !TOKEN.test(output.name))
        fault(
          "invalid-stage-checkpoint-token",
          `${location}/outputs/${outputIndex}/name`,
          "token required",
        );
      safeRelative(output.path, `${location}/outputs/${outputIndex}/path`);
      outputNames.push(output.name);
    }
    tokens([...outputNames].sort(), `${location}/outputNames`);
    stageIds.push(stage.id);
  }
  tokens([...stageIds].sort(), "$/declaration/stageIds");
  exactKeys(
    value.projections,
    ["protectedWorkflow", "generatedTemplate", "agentGuidance", "manual"],
    "$/declaration/projections",
  );
  exactKeys(
    value.authority,
    [
      "productionStageSkipping",
      "providerEffects",
      "credentials",
      "ambientEnvironment",
      "ambientClock",
      "v3BehaviorChange",
    ],
    "$/declaration/authority",
  );
  if (Object.values(value.authority).some((entry) => entry !== false))
    fault(
      "invalid-stage-checkpoint-authority",
      "$/declaration/authority",
      "shadow declaration cannot grant authority",
    );
  return value;
}

function select(declaration, platformId, stageId) {
  validateV4PlatformStageCheckpointDeclaration(declaration);
  const platform = declaration.platforms.find(
    (entry) => entry.id === platformId,
  );
  const stage = declaration.stages.find((entry) => entry.id === stageId);
  if (!platform || !stage)
    fault(
      "undeclared-stage-checkpoint",
      "$/request",
      "platform and stage must be declared",
    );
  return { platform, stage };
}

function outputManifest(stage, outputs) {
  exactKeys(
    outputs,
    stage.outputs.map((entry) => entry.name),
    "$/request/outputs",
  );
  const entries = stage.outputs
    .map(({ name }) => {
      const bytes = Buffer.from(outputs[name]);
      return { name, root: v4StageCapsuleBlobRoot(bytes), size: bytes.length };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const draft = {
    schema: V4_STAGE_CAPSULE_OUTPUT_MANIFEST_CONTRACT,
    entries,
    manifestRoot: ZERO_ROOT,
  };
  return { ...draft, manifestRoot: v4StageCapsuleOutputManifestRoot(draft) };
}

export function emitV4PlatformStageCheckpoint(request) {
  const { platform, stage } = select(
    request.declaration,
    request.platformId,
    request.stageId,
  );
  validateV4Clock(request.recordedAt, "$/request/recordedAt");
  if (request.stageOutcome !== "success")
    return Object.freeze({ emitted: false, reason: "stage-not-successful" });
  if (!Number.isSafeInteger(request.overheadMs) || request.overheadMs < 0)
    fault(
      "invalid-stage-checkpoint-overhead",
      "$/request/overheadMs",
      "non-negative integer required",
    );
  const inputs = declaredMap(request.inputs, stage.inputs, "$/request/inputs", {
    roots: true,
  });
  const environmentRoots = declaredMap(
    request.environment,
    stage.environment,
    "$/request/environment",
  );
  const toolchainRoots = declaredMap(
    request.toolchains,
    stage.toolchains,
    "$/request/toolchains",
    { roots: true },
  );
  const manifest = outputManifest(stage, request.outputs);
  const productionOutputRoots = declaredMap(
    request.productionOutputRoots,
    stage.outputs.map((entry) => entry.name),
    "$/request/productionOutputRoots",
    { roots: true },
  );
  const manifestRoots = manifest.entries.map(({ name, root }) => ({
    name,
    root,
  }));
  const productionLifecycleRoot = rootOf(request.productionLifecycleResult);
  const shadowLifecycleRoot = rootOf(request.shadowLifecycleResult);
  if (
    rootOf(productionOutputRoots) !== rootOf(manifestRoots) ||
    productionLifecycleRoot !== shadowLifecycleRoot
  )
    fault(
      "stage-checkpoint-production-drift",
      "$/request",
      "shadow checkpoint inputs differ from production bytes or lifecycle result",
    );
  const shadowComparison = {
    productionOutputRoots,
    shadowOutputRoots: manifestRoots,
    productionLifecycleRoot,
    shadowLifecycleRoot,
  };
  const identity = {
    schema: V4_STAGE_CAPSULE_IDENTITY_CONTRACT,
    sourceRoot: request.inputs["source-tree"],
    platform: platform.id,
    platformRoot: rootOf(platform),
    stage: stage.id,
    toolchainRoots,
    runtimeRoot: rootOf(request.runtime),
    policyRoot: rootOf(stage),
    declaredInputs: inputs,
    transformationRoot: rootOf(request.transformation),
    outputManifestRoot: manifest.manifestRoot,
    qualificationRoot: rootOf(request.qualification),
    observationRoots: [
      { name: "declared-environment", root: rootOf(environmentRoots) },
      { name: "shadow-comparison", root: rootOf(shadowComparison) },
    ],
  };
  const capsule = {
    schema: V4_STAGE_CAPSULE_CONTRACT,
    writerAuthority: "typescript-v3",
    rustAuthority: "validation-only",
    identity,
    identityRoot: v4StageCapsuleIdentityRoot(identity),
    retentionPromise: request.retentionPromise,
    capsuleRoot: ZERO_ROOT,
  };
  capsule.capsuleRoot = v4StageCapsuleRoot(capsule);
  validateV4StageCapsule(capsule);
  const blobs = manifest.entries.map((entry) => ({
    name: entry.name,
    bytes: Buffer.from(request.outputs[entry.name]),
  }));
  const receipt = request.store.put({
    capsule,
    manifest,
    blobs,
    recordedAt: request.recordedAt,
  });
  const body = {
    schema: V4_PLATFORM_STAGE_CHECKPOINT_CONTRACT,
    mode: "shadow-only",
    platform: platform.id,
    stage: stage.id,
    capsuleRoot: capsule.capsuleRoot,
    manifestRoot: manifest.manifestRoot,
    storeReceiptRoot: receipt.receiptRoot,
    productionBytesChanged: false,
    lifecycleResultChanged: false,
    overheadMs: request.overheadMs,
  };
  return {
    emitted: true,
    capsule,
    manifest,
    receipt,
    report: { ...body, reportRoot: rootOf(body) },
  };
}

function ensureEmptyDirectory(targetDirectory) {
  const target = path.resolve(targetDirectory);
  if (fs.existsSync(target) && fs.readdirSync(target).length !== 0)
    fault(
      "stage-checkpoint-restore-target-not-empty",
      "$/targetDirectory",
      "clean restore directory required",
    );
  fs.mkdirSync(target, { recursive: true });
  return target;
}

export function restoreV4PlatformStageCheckpoint(request) {
  const { stage } = select(
    request.declaration,
    request.expectedPlatform,
    request.expectedStage,
  );
  validateV4Clock(request.recordedAt, "$/request/recordedAt");
  const restored = request.store.restore({
    capsuleRoot: request.capsuleRoot,
    recordedAt: request.recordedAt,
  });
  if (
    restored.capsule.identity.platform !== request.expectedPlatform ||
    restored.capsule.identity.stage !== request.expectedStage
  )
    fault(
      "stage-checkpoint-identity-mismatch",
      "$/request",
      "restored platform or stage differs",
    );
  const target = ensureEmptyDirectory(request.targetDirectory);
  const byName = new Map(restored.blobs.map((entry) => [entry.name, entry]));
  for (const output of stage.outputs) {
    const blob = byName.get(output.name);
    if (!blob)
      fault(
        "stage-capsule-partial",
        `$/restore/${output.name}`,
        "declared output missing",
      );
    const destination = path.join(
      target,
      safeRelative(output.path, `$/restore/${output.name}`),
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, blob.bytes, { flag: "wx" });
    if (v4StageCapsuleBlobRoot(fs.readFileSync(destination)) !== blob.root)
      fault(
        "stage-capsule-root-mismatch",
        `$/restore/${output.name}`,
        "restored bytes differ",
      );
  }
  const body = {
    schema: V4_PLATFORM_STAGE_RESTORE_CONTRACT,
    platform: request.expectedPlatform,
    stage: request.expectedStage,
    capsuleRoot: request.capsuleRoot,
    manifestRoot: restored.manifest.manifestRoot,
    storeReceiptRoot: restored.receipt.receiptRoot,
    restoredOutputCount: stage.outputs.length,
    exactRootVerified: true,
    providerCredentialsUsed: false,
  };
  return { restored, report: { ...body, reportRoot: rootOf(body) } };
}
