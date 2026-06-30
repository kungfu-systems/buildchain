const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parse, stringify } = require("smol-toml");

const CONFIG_FILE = "buildchain.toml";
const RESERVED_LIFECYCLE_KEYS = new Set(["env", "shell"]);
const SUPPORTED_VERSION_FILE_TYPES = new Set(["json", "toml", "regex"]);

function posixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a table`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function getByDottedKey(target, key) {
  return String(key)
    .split(".")
    .reduce((current, segment) => current && current[segment], target);
}

function setByDottedKey(target, key, value) {
  const segments = String(key).split(".");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== "object" || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
}

function loadBuildchainConfig(cwd = process.cwd()) {
  const filePath = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const source = fs.readFileSync(filePath, "utf8");
  let config;
  try {
    config = parse(source);
  } catch (error) {
    throw new Error(`${CONFIG_FILE} parse failed: ${error.message}`);
  }
  if (config.schema !== 1) {
    throw new Error(`${CONFIG_FILE} schema must be 1`);
  }
  return {
    path: CONFIG_FILE,
    filePath,
    config: normalizeBuildchainConfig(config),
  };
}

function normalizeBuildchainConfig(config) {
  assertPlainObject(config, CONFIG_FILE);
  const normalized = { ...config };
  if (normalized.version !== undefined) {
    normalized.version = normalizeVersionSection(normalized.version);
  }
  if (normalized.lifecycle !== undefined) {
    normalized.lifecycle = normalizeLifecycleSection(normalized.lifecycle);
  }
  return normalized;
}

function normalizeVersionSection(version) {
  assertPlainObject(version, "version");
  const files = version.files === undefined ? [] : version.files;
  if (!Array.isArray(files)) {
    throw new Error("version.files must be an array of tables");
  }
  return {
    required: version.required === undefined ? false : Boolean(version.required),
    files: files.map((file, index) => normalizeVersionFile(file, index)),
  };
}

function normalizeVersionFile(file, index) {
  assertPlainObject(file, `version.files[${index}]`);
  const type = assertString(file.type, `version.files[${index}].type`);
  if (!SUPPORTED_VERSION_FILE_TYPES.has(type)) {
    throw new Error(`version.files[${index}].type must be one of json, toml, or regex`);
  }
  const normalized = {
    type,
    path: posixPath(assertString(file.path, `version.files[${index}].path`)),
  };
  if (type === "json" || type === "toml") {
    normalized.key = assertString(file.key, `version.files[${index}].key`);
  }
  if (type === "regex") {
    normalized.pattern = assertString(file.pattern, `version.files[${index}].pattern`);
    normalized.replacement = assertString(file.replacement, `version.files[${index}].replacement`);
  }
  return normalized;
}

function normalizeLifecycleSection(lifecycle) {
  assertPlainObject(lifecycle, "lifecycle");
  const normalized = {};
  if (lifecycle.shell !== undefined) {
    normalized.shell = assertString(lifecycle.shell, "lifecycle.shell");
  }
  if (lifecycle.env !== undefined) {
    normalized.env = normalizeEnv(lifecycle.env, "lifecycle.env");
  }
  for (const [name, value] of Object.entries(lifecycle)) {
    if (RESERVED_LIFECYCLE_KEYS.has(name)) {
      continue;
    }
    normalized[name] = normalizeLifecycleStage(value, `lifecycle.${name}`, normalized);
  }
  return normalized;
}

function normalizeEnv(env, label) {
  assertPlainObject(env, label);
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, String(value)]),
  );
}

function normalizeLifecycleStage(stage, label = "lifecycle stage", lifecycle = {}) {
  assertPlainObject(stage, label);
  const hasCommand = stage.command !== undefined;
  const hasCommands = stage.commands !== undefined;
  const hasScript = stage.script !== undefined;
  const modeCount = [hasCommand, hasCommands, hasScript].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error(`${label} must define exactly one of command, commands, or script`);
  }
  const normalized = {
    shell: stage.shell === undefined ? lifecycle.shell : assertString(stage.shell, `${label}.shell`),
    env: stage.env === undefined ? undefined : normalizeEnv(stage.env, `${label}.env`),
    timeoutMinutes: stage.timeout_minutes === undefined ? undefined : Number(stage.timeout_minutes),
    retries: stage.retries === undefined ? 1 : Number(stage.retries),
  };
  if (normalized.timeoutMinutes !== undefined && (!Number.isFinite(normalized.timeoutMinutes) || normalized.timeoutMinutes <= 0)) {
    throw new Error(`${label}.timeout_minutes must be a positive number`);
  }
  if (!Number.isInteger(normalized.retries) || normalized.retries < 1) {
    throw new Error(`${label}.retries must be a positive integer`);
  }
  if (hasCommand) {
    normalized.commands = [assertString(stage.command, `${label}.command`)];
    normalized.mode = "command";
  } else if (hasCommands) {
    if (!Array.isArray(stage.commands) || stage.commands.length === 0) {
      throw new Error(`${label}.commands must be a non-empty array`);
    }
    normalized.commands = stage.commands.map((command, index) =>
      assertString(command, `${label}.commands[${index}]`),
    );
    normalized.mode = "commands";
  } else {
    normalized.script = assertString(stage.script, `${label}.script`);
    normalized.mode = "script";
  }
  return normalized;
}

function getLifecycleStage(loadedConfig, name) {
  return loadedConfig && loadedConfig.config && loadedConfig.config.lifecycle && loadedConfig.config.lifecycle[name];
}

function runLifecycleStage({ cwd = process.cwd(), loadedConfig, name, stage, env: extraEnv }) {
  const lifecycle = (loadedConfig && loadedConfig.config && loadedConfig.config.lifecycle) || {};
  const selected = stage || getLifecycleStage(loadedConfig, name);
  if (!selected) {
    return false;
  }
  const env = {
    ...process.env,
    ...(lifecycle.env || {}),
    ...(selected.env || {}),
    ...(extraEnv || {}),
  };
  const timeout = selected.timeoutMinutes ? selected.timeoutMinutes * 60_000 : undefined;
  const execOptions = {
    cwd,
    env,
    stdio: "inherit",
    shell: selected.shell || true,
    timeout,
  };
  const runOnce = () => {
    if (selected.mode === "script") {
      execSync(selected.script, execOptions);
      return;
    }
    for (const command of selected.commands) {
      execSync(command, execOptions);
    }
  };
  let lastError;
  for (let attempt = 1; attempt <= selected.retries; attempt += 1) {
    try {
      runOnce();
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < selected.retries) {
        console.log(`> lifecycle ${name || "stage"} failed, retry ${attempt + 1}/${selected.retries}`);
      }
    }
  }
  throw lastError;
}

function discoverConfiguredVersionStateFiles(cwd = process.cwd(), loadedConfig = loadBuildchainConfig(cwd)) {
  const configured = (loadedConfig && loadedConfig.config && loadedConfig.config.version && loadedConfig.config.version.files) || [];
  const files = configured.map((entry) => {
    const filePath = path.join(cwd, entry.path);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Configured version file does not exist: ${entry.path}`);
    }
    const source = fs.readFileSync(filePath, "utf8");
    const file = { ...entry, source };
    if (entry.type === "json") {
      const content = JSON.parse(source);
      if (typeof getByDottedKey(content, entry.key) !== "string") {
        throw new Error(`Configured JSON version key is missing or not a string: ${entry.path}:${entry.key}`);
      }
      return { ...file, content };
    }
    if (entry.type === "toml") {
      const content = parse(source);
      if (typeof getByDottedKey(content, entry.key) !== "string") {
        throw new Error(`Configured TOML version key is missing or not a string: ${entry.path}:${entry.key}`);
      }
      return { ...file, content };
    }
    const pattern = new RegExp(entry.pattern, "m");
    const match = source.match(pattern);
    if (!match) {
      throw new Error(`Configured regex version pattern did not match: ${entry.path}`);
    }
    if (typeof (match.groups && match.groups.version) !== "string") {
      throw new Error(`Configured regex version pattern must define a named capture group called version: ${entry.path}`);
    }
    return { ...file, pattern };
  });
  if (loadedConfig && loadedConfig.config && loadedConfig.config.version && loadedConfig.config.version.required && files.length === 0) {
    throw new Error("version.required is true but no version.files are configured");
  }
  return files;
}

function configuredLifecycleStages(loadedConfig) {
  const lifecycle = (loadedConfig && loadedConfig.config && loadedConfig.config.lifecycle) || {};
  return Object.entries(lifecycle)
    .filter(([, stage]) => stage && typeof stage === "object" && typeof stage.mode === "string")
    .map(([name, stage]) => ({
      name,
      mode: stage.mode,
      timeoutMinutes: stage.timeoutMinutes,
      retries: stage.retries,
      commandCount: stage.mode === "script" ? 1 : stage.commands.length,
    }));
}

function validateBuildchainConfig(
  cwd = process.cwd(),
  {
    requireConfig = true,
    requireVersionState = false,
    requireLifecycleStages = [],
  } = {},
) {
  const loadedConfig = loadBuildchainConfig(cwd);
  if (!loadedConfig) {
    if (requireConfig) {
      throw new Error(`${CONFIG_FILE} is required`);
    }
    return {
      config: undefined,
      versionFiles: [],
      lifecycleStages: [],
    };
  }

  const versionFiles = loadedConfig.config.version
    ? discoverConfiguredVersionStateFiles(cwd, loadedConfig)
    : [];
  if (requireVersionState && versionFiles.length === 0) {
    throw new Error("version state is required but no version.files are configured");
  }

  const lifecycleStages = configuredLifecycleStages(loadedConfig);
  const stageNames = new Set(lifecycleStages.map((stage) => stage.name));
  const missingStages = requireLifecycleStages.filter((stage) => !stageNames.has(stage));
  if (missingStages.length > 0) {
    throw new Error(`required lifecycle stage missing: ${missingStages.join(", ")}`);
  }

  return {
    config: {
      path: loadedConfig.path,
      filePath: loadedConfig.filePath,
      schema: loadedConfig.config.schema,
    },
    versionFiles: versionFiles.map((file) => ({
      path: file.path,
      type: file.type,
      key: file.key,
      pattern: file.pattern && file.pattern.source,
    })),
    lifecycleStages,
  };
}

function updateConfiguredVersionStateContents(files, version) {
  return files
    .map((file) => {
      let content;
      if (file.type === "json") {
        const next = structuredClone(file.content);
        setByDottedKey(next, file.key, version);
        content = `${JSON.stringify(next, null, 2)}\n`;
      } else if (file.type === "toml") {
        const next = structuredClone(file.content);
        setByDottedKey(next, file.key, version);
        content = stringify(next);
      } else if (file.type === "regex") {
        content = file.source.replace(file.pattern, (...args) => {
          const groups = args[args.length - 1] || {};
          const current = groups.version;
          if (typeof current !== "string") {
            throw new Error(`Configured regex version pattern must define a named capture group called version: ${file.path}`);
          }
          return args[0].replace(current, file.replacement.replaceAll("${version}", version));
        });
      } else {
        throw new Error(`Unsupported configured version file type: ${file.type}`);
      }
      return {
        path: file.path,
        kind: file.type,
        changed: content !== file.source,
        content,
      };
    })
    .filter((file) => file.changed);
}

function writeLifecycleScriptFixture(cwd, name, script) {
  const filePath = path.join(cwd, `${name}-${Date.now()}.sh`);
  fs.writeFileSync(filePath, script.replace(/\$\{TMPDIR\}/g, os.tmpdir()));
  return filePath;
}

module.exports = {
  discoverConfiguredVersionStateFiles,
  getLifecycleStage,
  loadBuildchainConfig,
  normalizeBuildchainConfig,
  normalizeLifecycleStage,
  runLifecycleStage,
  updateConfiguredVersionStateContents,
  validateBuildchainConfig,
  writeLifecycleScriptFixture,
};
