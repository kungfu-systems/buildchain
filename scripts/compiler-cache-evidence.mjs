import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILDCHAIN_COMPILER_CACHE_PREPARATION_CONTRACT =
  "kungfu-buildchain-compiler-cache-preparation";

const SCCACHE_COMPILER_BINDINGS = Object.freeze({
  RUSTC_WRAPPER: "sccache",
  CMAKE_C_COMPILER_LAUNCHER: "sccache",
  CMAKE_CXX_COMPILER_LAUNCHER: "sccache",
});

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}

function cleanText(value) {
  return String(value || "").trim();
}

function optionalDigest(value, label) {
  const candidate = cleanText(value);
  if (!candidate) return "";
  if (!DIGEST_RE.test(candidate)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return candidate;
}

function defaultRunCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function assertCommandSucceeded(result, label) {
  if (result?.error) {
    throw new Error(`${label} failed: ${result.error.code || result.error.message}`);
  }
  if (result?.status !== 0) {
    const detail = cleanText(result?.stderr || result?.stdout);
    throw new Error(`${label} exited ${result?.status ?? "without status"}${detail ? `: ${detail}` : ""}`);
  }
}

function appendGithubEnv(filePath, values) {
  if (!filePath) return;
  for (const [name, value] of Object.entries(values)) {
    if (/[\r\n\0]/.test(String(value))) {
      throw new Error(`${name} contains control characters`);
    }
  }
  fs.appendFileSync(
    filePath,
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
  );
}

function sumCounters(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((total, entry) => total + sumCounters(entry), 0);
}

function readSccacheStats({ cwd, env, runCommand }) {
  const result = runCommand(
    "sccache",
    ["--show-stats", "--stats-format", "json"],
    { cwd, env },
  );
  assertCommandSucceeded(result, "sccache current-run stats probe");
  let payload;
  try {
    payload = JSON.parse(cleanText(result.stdout));
  } catch {
    throw new Error("sccache current-run stats probe returned invalid JSON");
  }
  const stats = payload?.stats || payload;
  return {
    compileRequests: sumCounters(stats?.compile_requests),
    cacheHits: sumCounters(stats?.cache_hits),
    cacheMisses: sumCounters(stats?.cache_misses),
  };
}

function readToolEvidence({ cwd, env, expectedRoot }) {
  const configured = cleanText(
    env.BUILDCHAIN_COMPILER_CACHE_TOOL_EVIDENCE_PATH,
  );
  if (!configured) return undefined;
  const filePath = path.resolve(cwd, configured);
  const relative = path.relative(path.resolve(cwd), filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      "BUILDCHAIN_COMPILER_CACHE_TOOL_EVIDENCE_PATH must remain inside the workflow workspace",
    );
  }
  const evidence = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!DIGEST_RE.test(evidence?.root || "")) {
    throw new Error("compiler-cache tool evidence root is invalid");
  }
  if (expectedRoot && evidence.root !== expectedRoot) {
    throw new Error(
      "compiler-cache tool evidence does not match BUILDCHAIN_COMPILER_CACHE_TOOL_ROOT",
    );
  }
  return evidence;
}

export function prepareCompilerCacheEvidence({
  cwd = process.cwd(),
  env = process.env,
  runCommand = defaultRunCommand,
  now = () => new Date(),
} = {}) {
  const provider = cleanText(env.BUILDCHAIN_COMPILER_CACHE_PROVIDER || "none").toLowerCase();
  const required = cleanText(env.BUILDCHAIN_COMPILER_CACHE_REQUIRED).toLowerCase() === "true";
  if (provider !== "sccache") {
    if (required) {
      throw new Error(`required compiler cache provider must be sccache, received ${provider || "empty"}`);
    }
    return undefined;
  }

  const outputPath = path.resolve(
    cwd,
    cleanText(env.BUILDCHAIN_COMPILER_CACHE_PREPARATION_PATH) ||
      ".buildchain/diagnostics/compiler-cache-preparation.json",
  );
  const versionResult = runCommand("sccache", ["--version"], { cwd, env });
  assertCommandSucceeded(versionResult, "sccache version probe");
  const version = cleanText(versionResult.stdout).split(/\r?\n/, 1)[0];
  if (!version) {
    throw new Error("sccache version probe returned empty output");
  }

  const resetResult = runCommand("sccache", ["--zero-stats"], { cwd, env });
  assertCommandSucceeded(resetResult, "sccache current-run stats reset");

  const compilerCacheToolRoot = optionalDigest(
    env.BUILDCHAIN_COMPILER_CACHE_TOOL_ROOT,
    "BUILDCHAIN_COMPILER_CACHE_TOOL_ROOT",
  );
  const toolEvidence = readToolEvidence({
    cwd,
    env,
    expectedRoot: compilerCacheToolRoot,
  });
  const bindings = Object.fromEntries(
    [
      ["sourceCommit", cleanText(env.BUILDCHAIN_SOURCE_SHA || env.GITHUB_SHA)],
      ["sourceTree", cleanText(env.BUILDCHAIN_SOURCE_TREE_SHA)],
      ["runtimeCommit", cleanText(env.BUILDCHAIN_RUNTIME_SHA)],
      ["dependencyLockRoot", cleanText(env.BUILDCHAIN_DEPENDENCY_LOCK_ROOT)],
      ["toolchainRoot", cleanText(env.BUILDCHAIN_TOOLCHAIN_ROOT)],
      ["policyRoot", cleanText(env.BUILDCHAIN_CACHE_POLICY_ROOT)],
      ["cacheProfileRoot", optionalDigest(env.SHIFU_CACHE_PROFILE_DIGEST, "SHIFU_CACHE_PROFILE_DIGEST")],
      ["compilerCacheToolRoot", compilerCacheToolRoot],
    ].filter(([, value]) => value),
  );
  if (!bindings.sourceCommit) {
    throw new Error("BUILDCHAIN_SOURCE_SHA is required for compiler-cache preparation evidence");
  }

  const body = {
    schemaVersion: 1,
    contract: BUILDCHAIN_COMPILER_CACHE_PREPARATION_CONTRACT,
    generatedAt: now().toISOString(),
    provider,
    required,
    status: "prepared",
    platform: {
      id: cleanText(env.BUILDCHAIN_PLATFORM_ID) || "unknown",
      os: cleanText(env.RUNNER_OS) || process.platform,
      arch: cleanText(env.RUNNER_ARCH) || process.arch,
    },
    tool: {
      command: "sccache",
      version,
      ...(bindings.compilerCacheToolRoot
        ? { evidenceRoot: bindings.compilerCacheToolRoot }
        : {}),
      ...(toolEvidence ? { evidence: toolEvidence } : {}),
    },
    action: {
      statsReset: true,
      command: ["sccache", "--zero-stats"],
      compilerBindings: SCCACHE_COMPILER_BINDINGS,
    },
    bindings,
  };
  const receipt = {
    ...body,
    root: digest(body),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  appendGithubEnv(env.GITHUB_ENV, {
    BUILDCHAIN_COMPILER_CACHE_ACTIVE_PROVIDER: provider,
    BUILDCHAIN_COMPILER_CACHE_PREPARATION_PATH: outputPath,
    BUILDCHAIN_COMPILER_CACHE_PREPARATION_ROOT: receipt.root,
    ...SCCACHE_COMPILER_BINDINGS,
  });
  return receipt;
}

export function verifyCompilerCacheActivity({
  cwd = process.cwd(),
  env = process.env,
  runCommand = defaultRunCommand,
} = {}) {
  const provider = cleanText(
    env.BUILDCHAIN_COMPILER_CACHE_ACTIVE_PROVIDER ||
      env.BUILDCHAIN_COMPILER_CACHE_PROVIDER ||
      "none",
  ).toLowerCase();
  const required = cleanText(env.BUILDCHAIN_COMPILER_CACHE_REQUIRED).toLowerCase() === "true";
  if (provider !== "sccache") {
    if (required) {
      throw new Error(`required compiler cache provider must be sccache, received ${provider || "empty"}`);
    }
    return undefined;
  }

  const stats = readSccacheStats({ cwd, env, runCommand });
  const cacheableRequests = stats.cacheHits + stats.cacheMisses;
  if (required && stats.compileRequests < 1) {
    throw new Error(
      "required sccache observed zero compile requests; compiler launcher bindings were not effective",
    );
  }
  if (required && cacheableRequests < 1) {
    throw new Error(
      "required sccache observed no cacheable compiler requests",
    );
  }
  return {
    ...stats,
    cacheableRequests,
  };
}

function main() {
  const command = process.argv[2] || "";
  if (!new Set(["prepare", "verify"]).has(command)) {
    throw new Error("usage: node scripts/compiler-cache-evidence.mjs <prepare|verify>");
  }
  if (command === "prepare") {
    const receipt = prepareCompilerCacheEvidence();
    if (receipt) {
      console.log(`compiler_cache_provider=${receipt.provider}`);
      console.log(`compiler_cache_preparation_root=${receipt.root}`);
    } else {
      console.log("compiler_cache_provider=none");
    }
  } else {
    const activity = verifyCompilerCacheActivity();
    if (activity) {
      console.log(`compiler_cache_compile_requests=${activity.compileRequests}`);
      console.log(`compiler_cache_hits=${activity.cacheHits}`);
      console.log(`compiler_cache_misses=${activity.cacheMisses}`);
    } else {
      console.log("compiler_cache_activity=not-applicable");
    }
  }
}

const isMain = process.argv[1] &&
  path.basename(process.argv[1]) === "compiler-cache-evidence.mjs" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
