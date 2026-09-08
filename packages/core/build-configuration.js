import fs from "node:fs";
import path from "node:path";

// Project choices only. Provider endpoints, roles, runner labels and cache
// transport authority belong to the selected, runtime-owned environment.
const sections = {
  tools: { node: "24", rust: "", go: "" },
  artifacts: {
    name: "buildchain-artifact", paths: ["dist", "build/stage"],
    required_paths: [], min_files: 0, max_files: Number.MAX_SAFE_INTEGER,
    min_total_bytes: 0, retention_days: 14, compression_level: 0,
    release_candidate: false,
  },
  diagnostics: {
    sample_process_tree: true, sample_interval_ms: 15000,
    requested_parallelism: 0,
  },
  verification: { substage_evidence_path: "" },
  finalization: { command: "", on_platform: false },
  transport_smoke: { scenario_path: "", artifact_root: "." },
  attestation: { subject_path: "", platform: "linux-x64" },
  macos_signing: { app_path: "", platform: "macos-arm64" },
  contract: {
    compatibility_policy: "major-compatible",
    drift_issue_mode: "compatible-and-breaking",
  },
  evidence: { gate_profile_path: "", candidate_family_path: "" },
};
const choices = {
  "contract.compatibility_policy": ["major-compatible", "allow-additive", "exact"],
  "contract.drift_issue_mode": ["off", "breaking-only", "compatible-and-breaking"],
};
const ranges = {
  timeout_minutes: [1, 360],
  "artifacts.retention_days": [1, 90],
  "artifacts.compression_level": [0, 9],
  "artifacts.min_files": [0, Number.MAX_SAFE_INTEGER],
  "artifacts.max_files": [0, Number.MAX_SAFE_INTEGER],
  "artifacts.min_total_bytes": [0, Number.MAX_SAFE_INTEGER],
  "diagnostics.sample_interval_ms": [100, 3600000],
  "diagnostics.requested_parallelism": [0, 1024],
};

function table(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a table`);
  }
  return value;
}

function fields(value, defaults, prefix) {
  table(value, `build.${prefix}`);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown build.${prefix}${key}`);
  }
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const label = `${prefix}${key}`;
    const selected = value[key] === undefined ? structuredClone(fallback) : value[key];
    const valid = Array.isArray(fallback)
      ? Array.isArray(selected) && selected.every((item) => typeof item === "string" && item.trim())
      : typeof selected === typeof fallback;
    if (!valid || (typeof selected === "string" && /\0/u.test(selected))) {
      throw new Error(`Invalid build.${label} type or multiline value`);
    }
    if (ranges[label] && (!Number.isInteger(selected) || selected < ranges[label][0] || selected > ranges[label][1])) {
      throw new Error(`build.${label} must be an integer in ${ranges[label].join("..")}`);
    }
    if (choices[label] && !choices[label].includes(selected)) throw new Error(`Invalid build.${label}: ${selected}`);
    return [key, selected];
  }));
}

export function normalizeBuildConfiguration(value = {}) {
  table(value, "build");
  const { environment = "github-hosted", fail_fast = false, timeout_minutes = 120, ...groups } = value;
  const result = fields({ environment, fail_fast, timeout_minutes }, { environment: "github-hosted", fail_fast: false, timeout_minutes: 120 }, "");
  if (!/^[a-z][a-z0-9-]*$/u.test(result.environment)) throw new Error("Invalid build.environment profile name");
  for (const name of Object.keys(groups)) {
    if (!Object.hasOwn(sections, name)) throw new Error(`Unknown build.${name}`);
  }
  for (const [name, defaults] of Object.entries(sections)) {
    result[name] = fields(groups[name] === undefined ? {} : groups[name], defaults, `${name}.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(result.artifacts.name)) throw new Error("Invalid build.artifacts.name");
  if (result.artifacts.min_files > result.artifacts.max_files) throw new Error("build.artifacts.min_files exceeds max_files");
  return result;
}

export function containedBuildPath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\") || /[\r\n\0]/u.test(relative) || relative.split("/").includes("..")) {
    throw new Error("Build configuration paths must remain repository-relative");
  }
  const resolved = path.resolve(root, relative);
  const realRoot = fs.realpathSync(root);
  // Reject symlink escape through any existing parent, including a missing leaf.
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Build configuration path escapes repository: ${relative}`);
  }
  return resolved;
}

export function discoverBuildConfiguration(root, locator = "") {
  const candidates = locator ? [locator] : [".buildchain/buildchain.toml", "buildchain.toml"];
  const found = candidates.filter((candidate) => fs.existsSync(containedBuildPath(root, candidate)));
  if (found.length !== 1) throw new Error(`Expected one buildchain.toml; found ${found.length}. Use config-path for a project outside the repository root.`);
  const configPath = found[0];
  if (path.basename(configPath) !== "buildchain.toml") throw new Error("config-path must locate a project's buildchain.toml");
  const directory = path.posix.dirname(configPath);
  const cwd = path.posix.basename(directory) === ".buildchain" ? path.posix.dirname(directory) : directory;
  // Lifecycle and planning must discover the same file, never a second config.
  const projectConfigs = [".buildchain/buildchain.toml", "buildchain.toml"].filter((candidate) => fs.existsSync(containedBuildPath(root, path.posix.join(cwd, candidate))));
  if (projectConfigs.length !== 1) throw new Error("Ambiguous project configuration");
  return { configPath, cwd };
}
