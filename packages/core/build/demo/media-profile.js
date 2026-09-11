import {
  MAX_BUNDLE_MEMBER_BYTES,
  invariant,
  sha256,
  readRegular,
  readJson,
  resolveInside,
  exactKeys,
  integer,
  text,
  semanticRoot,
} from "./io.js";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";

export function validateBudgetBasis(entry, label) {
  exactKeys(
    entry.budgetBasis,
    ["evidence", "observedPath", "observedBytes", "multiplier", "rounding"],
    [],
    `${label}.budgetBasis`,
  );
  invariant(
    entry.budgetBasis.evidence ===
      "contracts/evidence/auditable-demo-web-delivery-v1.json",
    `${label}.budgetBasis.evidence is unsupported`,
  );
  text(
    entry.budgetBasis.observedPath,
    1,
    128,
    `${label}.budgetBasis.observedPath`,
  );
  const observedBytes = integer(
    entry.budgetBasis.observedBytes,
    1,
    MAX_BUNDLE_MEMBER_BYTES,
    `${label}.budgetBasis.observedBytes`,
  );
  const multiplier = integer(
    entry.budgetBasis.multiplier,
    1,
    128,
    `${label}.budgetBasis.multiplier`,
  );
  invariant(
    entry.budgetBasis.rounding === "next-power-of-two",
    `${label}.budgetBasis.rounding is unsupported`,
  );
  const expected = 2 ** Math.ceil(Math.log2(observedBytes * multiplier));
  invariant(
    entry.maximumBytes === expected,
    `${label}.maximumBytes does not match its measured budget basis`,
  );
}

export function loadMediaProfile(profileId) {
  const catalog = readJson(
    path.join(
      installationRoot(import.meta.url),
      "contracts/auditable-demo-media-profiles-v1.json",
    ),
    "auditable demo media profile catalog",
  );
  invariant(
    catalog.schema === "buildchain.auditable-demo-media-profiles/v1",
    "unsupported media profile catalog",
  );
  invariant(
    catalog.profiles && typeof catalog.profiles === "object",
    "media profile catalog is invalid",
  );
  const seen = new Set();
  const resolve = (identifier) => {
    invariant(
      !seen.has(identifier),
      `media profile inheritance cycle: ${identifier}`,
    );
    const declared = catalog.profiles[identifier];
    invariant(
      declared && typeof declared === "object",
      `unsupported media profile: ${identifier}`,
    );
    seen.add(identifier);
    const inherited = declared.extends
      ? resolve(declared.extends)
      : {
          mode: "archive",
          renditions: [],
          singletonRoles: [],
          additionalRenditions: null,
        };
    seen.delete(identifier);
    const byPath = new Map(
      inherited.renditions.map((entry) => [entry.path, entry]),
    );
    for (const entry of declared.renditions || []) {
      invariant(
        entry && typeof entry === "object" && typeof entry.path === "string",
        `${identifier} rendition is invalid`,
      );
      byPath.set(entry.path, { ...(byPath.get(entry.path) || {}), ...entry });
    }
    return {
      mode: declared.mode || inherited.mode,
      renditions: [...byPath.values()],
      singletonRoles: [
        ...new Set([
          ...(inherited.singletonRoles || []),
          ...(declared.singletonRoles || []),
        ]),
      ],
      additionalRenditions:
        declared.additionalRenditions || inherited.additionalRenditions || null,
    };
  };
  const resolved = resolve(profileId);
  const profile = { id: profileId, ...resolved };
  for (const [index, entry] of profile.renditions.entries()) {
    if (profile.mode === "web-delivery") {
      invariant(
        entry.budgetBasis,
        `${profileId}.renditions[${index}].budgetBasis is required`,
      );
      validateBudgetBasis(entry, `${profileId}.renditions[${index}]`);
    }
  }
  return {
    catalog,
    catalogRoot: semanticRoot(catalog),
    profile,
    profileRoot: semanticRoot(profile),
  };
}

export function constraintsForAdditionalRendition(entry, policy) {
  const common = {
    path: entry.path,
    role: entry.role,
    mimeType: entry.mimeType,
    maximumBytes: policy.maximumBytesByMimeType[entry.mimeType],
    audioStreams: 0,
  };
  if (entry.mimeType === "video/mp4") {
    return {
      ...common,
      container: "mp4",
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      progressiveDownload: "moov-before-mdat",
    };
  }
  if (entry.mimeType === "video/webm") {
    return {
      ...common,
      container: "webm",
      videoCodec: "vp9",
      pixelFormat: "yuv420p",
    };
  }
  if (entry.mimeType === "image/webp")
    return { ...common, container: "webp", videoCodec: "webp" };
  if (entry.mimeType === "image/avif")
    return { ...common, container: "avif", videoCodec: "av1" };
  throw new Error(
    `additional rendition MIME type is not allowed: ${entry.mimeType}`,
  );
}

export function expectedRenditionDimensions(rule, scene) {
  if (rule.dimensions === undefined) {
    return {
      policy: "scene-exact",
      width: scene.width,
      height: scene.height,
    };
  }
  exactKeys(
    rule.dimensions,
    ["policy", "width", "height"],
    [],
    `${rule.path}.dimensions`,
  );
  invariant(
    rule.dimensions.policy === "exact-downscale-same-aspect",
    `${rule.path} dimension policy is unsupported`,
  );
  const width = integer(
    rule.dimensions.width,
    1,
    16384,
    `${rule.path}.dimensions.width`,
  );
  const height = integer(
    rule.dimensions.height,
    1,
    16384,
    `${rule.path}.dimensions.height`,
  );
  invariant(
    width <= scene.width && height <= scene.height,
    `${rule.path} dimensions would upscale the scene`,
  );
  invariant(
    width * scene.height === height * scene.width,
    `${rule.path} dimensions drift from the scene aspect ratio`,
  );
  return {
    policy: rule.dimensions.policy,
    width,
    height,
  };
}

function qualifyMediaFacts(facts, rule, scene, catalog) {
  const expectedDimensions = expectedRenditionDimensions(rule, scene);
  invariant(
    facts && typeof facts === "object",
    `${rule.path} inspection is missing`,
  );
  invariant(
    facts.container === rule.container,
    `${rule.path} container mismatch`,
  );
  invariant(
    facts.videoCodec === rule.videoCodec,
    `${rule.path} video codec mismatch`,
  );
  if (rule.pixelFormat)
    invariant(
      facts.pixelFormat === rule.pixelFormat,
      `${rule.path} pixel format mismatch`,
    );
  invariant(
    facts.audioStreams === rule.audioStreams,
    `${rule.path} audio stream policy failed`,
  );
  invariant(
    facts.width === expectedDimensions.width &&
      facts.height === expectedDimensions.height,
    `${rule.path} dimensions mismatch`,
  );
  if (facts.durationMs > 0) {
    invariant(
      Math.abs(facts.durationMs - scene.durationMs) <=
        catalog.qualification.durationToleranceMs,
      `${rule.path} duration mismatch`,
    );
  }
  if (rule.frameRatePolicy === "scene-exact") {
    invariant(
      Math.abs(facts.frameRate - scene.fps) < 0.001,
      `${rule.path} frame rate mismatch`,
    );
  }
  if (rule.progressiveDownload) {
    invariant(
      facts.progressiveDownload === rule.progressiveDownload,
      `${rule.path} progressive download evidence mismatch`,
    );
  }
}

export function qualifyRendererOutput(
  renderOutput,
  manifest,
  scene,
  profileId,
  inspectMedia,
  inspectionRoot = "",
) {
  const loaded = loadMediaProfile(profileId);
  const { profile, catalog } = loaded;
  const outputs = manifest.outputs || {};
  const rules = profile.renditions.map((entry) => ({ ...entry }));
  const knownPaths = new Set(rules.map((entry) => entry.path));
  const declaration = manifest.webDelivery;
  if (declaration !== undefined) {
    exactKeys(
      declaration,
      ["schema", "renditions"],
      [],
      "manifest.webDelivery",
    );
    invariant(
      declaration.schema === "build-images.auditable-demo-web-delivery/v1",
      "unsupported renderer web-delivery declaration",
    );
    invariant(
      Array.isArray(declaration.renditions),
      "manifest.webDelivery.renditions must be an array",
    );
    for (const [index, entry] of declaration.renditions.entries()) {
      exactKeys(
        entry,
        ["path", "role", "mimeType"],
        [],
        `manifest.webDelivery.renditions[${index}]`,
      );
      invariant(
        !knownPaths.has(entry.path),
        `renderer web-delivery path is already profile-owned: ${entry.path}`,
      );
      const policy = profile.additionalRenditions;
      invariant(
        policy,
        `media profile ${profileId} does not admit additional renditions`,
      );
      invariant(
        policy.allowedRoles.includes(entry.role),
        `additional rendition role is not allowed: ${entry.role}`,
      );
      invariant(
        policy.allowedMimeTypes.includes(entry.mimeType),
        `additional rendition MIME type is not allowed: ${entry.mimeType}`,
      );
      const maximumBytes = policy.maximumBytesByMimeType?.[entry.mimeType];
      integer(
        maximumBytes,
        1,
        MAX_BUNDLE_MEMBER_BYTES,
        `media profile ${profileId} additional ${entry.mimeType} budget`,
      );
      rules.push(constraintsForAdditionalRendition(entry, policy));
      knownPaths.add(entry.path);
    }
  }
  for (const name of Object.keys(outputs)) {
    if (name !== "media-probe.json")
      invariant(knownPaths.has(name), `unbound renderer output: ${name}`);
  }
  const singletonRoles = new Set(profile.singletonRoles || []);
  const observedRoles = new Set();
  const renditions = [];
  for (const rule of rules) {
    const declared = outputs[rule.path];
    invariant(
      declared && typeof declared === "object",
      `required renderer output is missing: ${rule.path}`,
    );
    const target = resolveInside(
      renderOutput,
      rule.path,
      "renderer output path",
    );
    const bytes = readRegular(target, rule.path, MAX_BUNDLE_MEMBER_BYTES);
    invariant(
      declared.root === sha256(bytes),
      `renderer manifest root mismatch: ${rule.path}`,
    );
    invariant(
      declared.bytes === bytes.length,
      `renderer manifest byte count mismatch: ${rule.path}`,
    );
    if (rule.maximumBytes !== undefined) {
      invariant(
        bytes.length <= rule.maximumBytes,
        `${rule.path} byte budget exceeded`,
      );
    }
    if (singletonRoles.has(rule.role)) {
      invariant(
        !observedRoles.has(rule.role),
        `duplicate singleton role: ${rule.role}`,
      );
      observedRoles.add(rule.role);
    }
    const facts = profile.mode === "web-delivery" ? inspectMedia(target) : {};
    if (profile.mode === "web-delivery") {
      qualifyMediaFacts(facts, rule, scene, catalog);
    }
    renditions.push({
      path: rule.path,
      role: rule.role,
      mimeType: rule.mimeType,
      root: declared.root,
      bytes: declared.bytes,
      maximumBytes: rule.maximumBytes || 0,
      dimensionPolicy:
        profile.mode === "web-delivery"
          ? expectedRenditionDimensions(rule, scene).policy
          : "not-qualified",
      ...facts,
    });
  }
  const body = {
    schema: "buildchain.auditable-demo-media-qualification/v1",
    profile: {
      id: profileId,
      mode: profile.mode,
      catalogRoot: loaded.catalogRoot,
      profileRoot: loaded.profileRoot,
    },
    inspectionRoot,
    renditions,
    nonClaims: catalog.qualification.nonClaims,
  };
  return { ...body, qualificationRoot: semanticRoot(body) };
}
