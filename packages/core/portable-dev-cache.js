import crypto from "node:crypto";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_RE = /^[0-9a-f]{40,64}$/;
const SAFE_PATH_RE = /^(?:~\/|[A-Za-z0-9._-]+\/)[A-Za-z0-9._/+-]+$/;
const LAYERS = new Set(["dependency", "compiler"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(ordered(value));
}

function digest(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value))
    .digest("hex")}`;
}

function shortDigest(value) {
  return value.replace(/^sha256:/, "").slice(0, 24);
}

function exactKeys(value, allowed, label) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  for (const key of Object.keys(value))
    assert(allowed.has(key), `${label}.${key} is not allowed`);
}

function checkedText(value, label) {
  assert(
    typeof value === "string" && value.trim() === value && value.length > 0,
    `${label} is required`,
  );
  assert(!/[\r\n\0]/.test(value), `${label} contains control characters`);
  return value;
}

function checkedDigest(value, label) {
  assert(DIGEST_RE.test(value), `${label} must be a sha256 digest`);
  return value;
}

function normalizeRoots(roots) {
  assert(
    Array.isArray(roots) && roots.length > 0 && roots.length <= 8,
    "roots must contain 1-8 entries",
  );
  const ids = new Set();
  const paths = new Set();
  return roots
    .map((root, index) => {
      exactKeys(root, new Set(["id", "path"]), `roots[${index}]`);
      const id = checkedText(root.id, `roots[${index}].id`);
      assert(
        /^[a-z0-9][a-z0-9-]{0,31}$/.test(id),
        `roots[${index}].id is invalid`,
      );
      const normalizedPath = checkedText(
        root.path,
        `roots[${index}].path`,
      ).replaceAll("\\", "/");
      assert(
        SAFE_PATH_RE.test(normalizedPath),
        `roots[${index}].path must be workspace-relative or start with ~/`,
      );
      assert(
        !normalizedPath.split("/").includes(".."),
        `roots[${index}].path cannot escape its root`,
      );
      assert(!ids.has(id), `duplicate root id: ${id}`);
      assert(
        !paths.has(normalizedPath),
        `duplicate cache root: ${normalizedPath}`,
      );
      ids.add(id);
      paths.add(normalizedPath);
      return { id, path: normalizedPath };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeManifest(manifest) {
  exactKeys(
    manifest,
    new Set(["schema", "layer", "roots", "identity"]),
    "manifest",
  );
  assert(
    manifest.schema === "buildchain.portable-dev-cache-manifest/v1",
    "unsupported portable dev cache manifest schema",
  );
  assert(LAYERS.has(manifest.layer), "layer must be dependency or compiler");
  exactKeys(
    manifest.identity,
    new Set([
      "platform",
      "arch",
      "runnerImage",
      "toolchainDigest",
      "dependencyLockDigest",
      "profileDigest",
      "sourceSha",
      "planDigest",
    ]),
    "manifest.identity",
  );
  const identity = {
    platform: checkedText(
      manifest.identity.platform,
      "manifest.identity.platform",
    ).toLowerCase(),
    arch: checkedText(
      manifest.identity.arch,
      "manifest.identity.arch",
    ).toLowerCase(),
    runnerImage: checkedText(
      manifest.identity.runnerImage,
      "manifest.identity.runnerImage",
    ),
    toolchainDigest: checkedDigest(
      manifest.identity.toolchainDigest,
      "manifest.identity.toolchainDigest",
    ),
    dependencyLockDigest: checkedDigest(
      manifest.identity.dependencyLockDigest,
      "manifest.identity.dependencyLockDigest",
    ),
    profileDigest: checkedDigest(
      manifest.identity.profileDigest,
      "manifest.identity.profileDigest",
    ),
    sourceSha: checkedText(
      manifest.identity.sourceSha,
      "manifest.identity.sourceSha",
    ).toLowerCase(),
    planDigest: checkedDigest(
      manifest.identity.planDigest,
      "manifest.identity.planDigest",
    ),
  };
  assert(
    SOURCE_RE.test(identity.sourceSha),
    "manifest.identity.sourceSha must be a 40-64 character Git SHA",
  );
  return {
    schema: manifest.schema,
    layer: manifest.layer,
    roots: normalizeRoots(manifest.roots),
    identity,
  };
}

export function createPortableDevCachePlan(manifest) {
  const normalized = normalizeManifest(manifest);
  const compatibility = {
    schema: normalized.schema,
    layer: normalized.layer,
    roots: normalized.roots,
    platform: normalized.identity.platform,
    arch: normalized.identity.arch,
    runnerImage: normalized.identity.runnerImage,
    toolchainDigest: normalized.identity.toolchainDigest,
    dependencyLockDigest: normalized.identity.dependencyLockDigest,
    profileDigest: normalized.identity.profileDigest,
  };
  const compatibilityDigest = digest(compatibility);
  const exactRootDigest = digest({
    compatibilityDigest,
    sourceSha: normalized.identity.sourceSha,
    planDigest: normalized.identity.planDigest,
  });
  const prefix = [
    "buildchain-pdc-v1",
    normalized.layer,
    normalized.identity.platform.replace(/[^a-z0-9_-]+/g, "-"),
    normalized.identity.arch.replace(/[^a-z0-9_-]+/g, "-"),
    shortDigest(compatibilityDigest),
  ].join("-");
  const plan = {
    schema: "buildchain.portable-dev-cache-plan/v1",
    provider: "github-actions-cache",
    manifest: normalized,
    compatibilityDigest,
    exactRootDigest,
    key: `${prefix}-${shortDigest(exactRootDigest)}`,
    restoreKeys: [`${prefix}-`],
    paths: normalized.roots.map(({ path }) => path),
  };
  return { ...plan, planDigest: digest(plan) };
}

export function verifyPortableDevCachePlan(plan) {
  assert(
    plan?.schema === "buildchain.portable-dev-cache-plan/v1",
    "unsupported portable dev cache plan schema",
  );
  const { planDigest, ...body } = plan;
  assert(planDigest === digest(body), "portable dev cache plan digest drift");
  const rebuilt = createPortableDevCachePlan(plan.manifest);
  assert(
    stableJson(rebuilt) === stableJson(plan),
    "portable dev cache plan does not match its manifest",
  );
  return true;
}

export function createPortableDevCacheReceipt({
  plan,
  matchedKey = "",
  cacheHit = "",
  validationStatus = "pass",
  validationReason = "",
  coldFallbackStatus = "not-run",
}) {
  verifyPortableDevCachePlan(plan);
  assert(
    ["", "true", "false"].includes(String(cacheHit)),
    "cacheHit must be empty, true, or false",
  );
  assert(
    ["pass", "fail"].includes(validationStatus),
    "validationStatus must be pass or fail",
  );
  assert(
    ["not-run", "passed", "failed"].includes(coldFallbackStatus),
    "coldFallbackStatus must be not-run, passed, or failed",
  );
  let outcome = "miss";
  if (matchedKey === plan.key && String(cacheHit) === "true") outcome = "exact";
  else if (
    matchedKey &&
    plan.restoreKeys.some((prefix) => matchedKey.startsWith(prefix)) &&
    String(cacheHit) !== "true"
  )
    outcome = "compatible";
  else if (matchedKey)
    throw new Error("matched cache key is outside the portable plan authority");
  else if (String(cacheHit) === "true")
    throw new Error("cacheHit=true requires the exact planned key");
  if (validationStatus === "fail") outcome = "corrupt";
  const cacheUsable =
    validationStatus === "pass" && ["exact", "compatible"].includes(outcome);
  const coldFallbackRequired = outcome === "miss" || outcome === "corrupt";
  if (!coldFallbackRequired && coldFallbackStatus !== "not-run") {
    throw new Error(
      "cold fallback evidence is only valid for miss or corrupt outcomes",
    );
  }
  const receipt = {
    schema: "buildchain.portable-dev-cache-receipt/v1",
    provider: plan.provider,
    planDigest: plan.planDigest,
    exactRootDigest: plan.exactRootDigest,
    compatibilityDigest: plan.compatibilityDigest,
    sourceSha: plan.manifest.identity.sourceSha,
    planRootDigest: plan.manifest.identity.planDigest,
    layer: plan.manifest.layer,
    outcome,
    usable: cacheUsable,
    coldFallbackRequired,
    coldFallbackStatus,
    qualified:
      cacheUsable ||
      (coldFallbackRequired && coldFallbackStatus === "passed"),
    matchedKey: matchedKey || null,
    validation: { status: validationStatus, reason: validationReason || null },
  };
  return { ...receipt, receiptDigest: digest(receipt) };
}
