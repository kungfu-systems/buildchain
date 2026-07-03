import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";

const CONFIG_FILE = "buildchain.toml";
const RESERVED_LIFECYCLE_KEYS = new Set(["env", "shell"]);
const SUPPORTED_VERSION_FILE_TYPES = new Set(["json", "toml", "regex"]);
const SUPPORTED_VERSION_STRATEGIES = new Set(["semver", "anchored"]);
const SUPPORTED_VERSION_NEXT = new Set(["auto", "manual"]);
const SUPPORTED_PROJECT_TYPES = new Set(["package", "web-surface", "infra-contract"]);
const SUPPORTED_PUBLISH_MODES = new Set(["publish-final-version", "promote-existing-version"]);
const SUPPORTED_PUBLISH_AUTH = new Set(["trusted-publishing", "npm-token"]);
const SUPPORTED_PACKAGE_SET_ORDER = new Set(["as-provided", "platforms-first-main-last"]);
const SUPPORTED_NATIVE_COMPILER_CACHE = new Set(["auto", "ccache", "sccache", "none"]);
const WEB_SURFACE_CHANNELS = ["preview", "staging", "production"];
const SUPPORTED_CHANNEL_VISIBILITY = new Set(["ephemeral", "protected", "public", "internal"]);
const SUPPORTED_ACCESS_CONTROL = new Set(["none", "managed-network", "edge-basic-auth", "oidc", "app-auth"]);
const SUPPORTED_EDGE_AUTH = new Set(["none", "cloudfront-basic-auth", "oidc", "app-auth"]);
const SUPPORTED_DEPLOY_ADAPTERS = new Set([
  "aws-s3-cloudfront",
  "aws-elastic-beanstalk",
  "aws-ecs-service",
]);
const SUPPORTED_INFRA_ADAPTERS = new Set([
  "manual-observed",
  "aws-cloudformation",
  "terraform",
  "opentofu",
  "pulumi",
  "aws-cdk",
  "aws-cli",
  "custom-command",
]);
const SUPPORTED_INFRA_ADOPTION_MODES = new Set([
  "validate-only",
  "plan-only",
  "observe-only",
  "manual-observed",
  "import-planned",
  "managed-apply",
]);
const SUPPORTED_INFRA_APPLY_MODES = new Set(["disabled", "manual-approval", "environment-approval"]);

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

function optionalBoolean(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

function normalizeStringArray(value, label) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((entry, index) => assertString(entry, `${label}[${index}]`));
}

function getByDottedKey(target, key) {
  return String(key)
    .split(".")
    .reduce((current, segment) => current?.[segment], target);
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

export function loadBuildchainConfig(cwd = process.cwd()) {
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

export function normalizeBuildchainConfig(config) {
  assertPlainObject(config, CONFIG_FILE);
  const normalized = { ...config };
  if (normalized.project !== undefined) {
    normalized.project = normalizeProjectSection(normalized.project);
  }
  if (normalized.version !== undefined) {
    normalized.version = normalizeVersionSection(normalized.version);
  }
  if (normalized.lifecycle !== undefined) {
    normalized.lifecycle = normalizeLifecycleSection(normalized.lifecycle);
  }
  if (normalized.publish !== undefined) {
    normalized.publish = normalizePublishSection(normalized.publish);
  }
  if (normalized.channels !== undefined) {
    normalized.channels = normalizeChannelsSection(normalized.channels, normalized.project);
  }
  if (normalized.deploy !== undefined) {
    normalized.deploy = normalizeDeploySection(normalized.deploy, normalized.project);
  }
  if (normalized.infra !== undefined) {
    normalized.infra = normalizeInfraSection(normalized.infra);
  }
  if (normalized.consumers !== undefined) {
    normalized.consumers = normalizeConsumersSection(normalized.consumers);
  }
  if (normalized.surfaces !== undefined) {
    normalized.surfaces = normalizeSurfacesSection(normalized.surfaces);
  }
  if (normalized.retention !== undefined) {
    normalized.retention = normalizeRetentionSection(normalized.retention);
  }
  if (normalized.security !== undefined) {
    normalized.security = normalizeSecuritySection(normalized.security);
  }
  if (normalized.diagnostics !== undefined) {
    normalized.diagnostics = normalizeDiagnosticsSection(normalized.diagnostics);
  }
  validateWebSurfaceConfig(normalized);
  validateInfraContractConfig(normalized);
  return normalized;
}

function normalizeDiagnosticsSection(diagnostics) {
  assertPlainObject(diagnostics, "diagnostics");
  const normalized = { ...diagnostics };
  if (diagnostics.native !== undefined) {
    normalized.native = normalizeNativeDiagnosticsProfile(diagnostics.native);
  }
  return normalized;
}

function normalizeNativeDiagnosticsProfile(native) {
  assertPlainObject(native, "diagnostics.native");
  const compilerCache = native.compiler_cache === undefined
    ? "auto"
    : assertString(native.compiler_cache, "diagnostics.native.compiler_cache");
  if (!SUPPORTED_NATIVE_COMPILER_CACHE.has(compilerCache)) {
    throw new Error("diagnostics.native.compiler_cache must be one of auto, ccache, sccache, or none");
  }
  return {
    enabled: optionalBoolean(native.enabled, false),
    sampleProcessTree: optionalBoolean(native.sample_process_tree, false),
    compilerCache,
    expectedTools: normalizeStringArray(native.expected_tools, "diagnostics.native.expected_tools"),
    artifactDirs: normalizeStringArray(native.artifact_dirs, "diagnostics.native.artifact_dirs").map(posixPath),
    cacheDirs: normalizeStringArray(native.cache_dirs, "diagnostics.native.cache_dirs").map(posixPath),
  };
}

export function getNativeDiagnosticsProfile(loadedConfig) {
  return loadedConfig?.config?.diagnostics?.native || {
    enabled: false,
    sampleProcessTree: false,
    compilerCache: "auto",
    expectedTools: [],
    artifactDirs: [],
    cacheDirs: [],
  };
}

function normalizePublishSection(publish) {
  assertPlainObject(publish, "publish");
  const mode = publish.mode === undefined
    ? "publish-final-version"
    : assertString(publish.mode, "publish.mode");
  if (!SUPPORTED_PUBLISH_MODES.has(mode)) {
    throw new Error("publish.mode must be one of publish-final-version or promote-existing-version");
  }
  const auth = publish.auth === undefined
    ? "trusted-publishing"
    : assertString(publish.auth, "publish.auth");
  if (!SUPPORTED_PUBLISH_AUTH.has(auth)) {
    throw new Error("publish.auth must be one of trusted-publishing or npm-token");
  }
  if (mode === "promote-existing-version" && auth !== "npm-token") {
    throw new Error('publish.mode = "promote-existing-version" requires publish.auth = "npm-token"');
  }
  const packageSetOrder = publish.package_set_order === undefined
    ? "as-provided"
    : assertString(publish.package_set_order, "publish.package_set_order");
  if (!SUPPORTED_PACKAGE_SET_ORDER.has(packageSetOrder)) {
    throw new Error("publish.package_set_order must be one of as-provided or platforms-first-main-last");
  }
  return {
    mode,
    auth,
    distTag: publish.dist_tag === undefined
      ? undefined
      : assertString(publish.dist_tag, "publish.dist_tag"),
    packageSetOrder,
    mainPackage: publish.main_package === undefined
      ? ""
      : assertString(publish.main_package, "publish.main_package"),
  };
}

function normalizeProjectSection(project) {
  assertPlainObject(project, "project");
  const type = assertString(project.type, "project.type");
  if (!SUPPORTED_PROJECT_TYPES.has(type)) {
    throw new Error("project.type must be one of package, web-surface, or infra-contract");
  }
  const normalized = { type };
  for (const key of ["name", "site"]) {
    if (project[key] !== undefined) {
      normalized[key] = assertString(project[key], `project.${key}`);
    }
  }
  return normalized;
}

function normalizeInfraSection(infra) {
  assertPlainObject(infra, "infra");
  const adapter = assertString(infra.adapter, "infra.adapter");
  if (!SUPPORTED_INFRA_ADAPTERS.has(adapter)) {
    throw new Error(
      "infra.adapter must be one of manual-observed, aws-cloudformation, terraform, opentofu, pulumi, aws-cdk, aws-cli, or custom-command",
    );
  }
  const adoptionMode = infra.adoption_mode === undefined
    ? (adapter === "manual-observed" ? "manual-observed" : "validate-only")
    : assertString(infra.adoption_mode, "infra.adoption_mode");
  if (!SUPPORTED_INFRA_ADOPTION_MODES.has(adoptionMode)) {
    throw new Error(
      "infra.adoption_mode must be one of validate-only, plan-only, observe-only, manual-observed, import-planned, or managed-apply",
    );
  }
  const applyMode = infra.apply === undefined
    ? "disabled"
    : assertString(infra.apply, "infra.apply");
  if (!SUPPORTED_INFRA_APPLY_MODES.has(applyMode)) {
    throw new Error("infra.apply must be one of disabled, manual-approval, or environment-approval");
  }
  const normalized = {
    adapter,
    adoptionMode,
    applyMode,
    environment: infra.environment === undefined ? "" : assertString(infra.environment, "infra.environment"),
    identityRef: infra.identity_ref === undefined ? "" : assertString(infra.identity_ref, "infra.identity_ref"),
    desired: normalizeStringArray(infra.desired, "infra.desired").map(posixPath),
    contract: normalizeStringArray(infra.contract, "infra.contract").map(posixPath),
    secretRefs: normalizeStringArray(infra.secret_refs, "infra.secret_refs"),
  };
  if (infra.commands !== undefined) {
    normalized.commands = normalizeInfraCommands(infra.commands);
  }
  assertNoInlineSecretValues(infra, "infra", new Set(["secret_refs", "commands"]));
  return normalized;
}

function normalizeInfraCommands(commands) {
  assertPlainObject(commands, "infra.commands");
  const normalized = {};
  for (const stage of ["validate", "plan", "apply", "observe"]) {
    if (commands[stage] !== undefined) {
      normalized[stage] = assertString(commands[stage], `infra.commands.${stage}`);
    }
  }
  return normalized;
}

function normalizeConsumersSection(consumers) {
  if (!Array.isArray(consumers)) {
    throw new Error("consumers must be an array of tables");
  }
  return consumers.map((consumer, index) => normalizeConsumerConfig(consumer, index));
}

function normalizeConsumerConfig(consumer, index) {
  assertPlainObject(consumer, `consumers[${index}]`);
  return {
    repo: assertString(consumer.repo, `consumers[${index}].repo`),
    path: posixPath(assertString(consumer.path, `consumers[${index}].path`)),
    source: posixPath(assertString(consumer.source, `consumers[${index}].source`)),
    branch: consumer.branch === undefined ? "" : assertString(consumer.branch, `consumers[${index}].branch`),
  };
}

function normalizeChannelsSection(channels) {
  assertPlainObject(channels, "channels");
  return Object.fromEntries(
    Object.entries(channels).map(([name, channel]) => [
      name,
      normalizeChannelConfig(name, channel),
    ]),
  );
}

function normalizeChannelConfig(name, channel) {
  assertPlainObject(channel, `channels.${name}`);
  const hasUrl = channel.url !== undefined;
  const hasUrlPattern = channel.url_pattern !== undefined;
  if (hasUrl && hasUrlPattern) {
    throw new Error(`channels.${name} must define only one of url or url_pattern`);
  }
  if (!hasUrl && !hasUrlPattern) {
    throw new Error(`channels.${name} must define url or url_pattern`);
  }
  const visibility = channel.visibility === undefined
    ? defaultChannelVisibility(name)
    : assertString(channel.visibility, `channels.${name}.visibility`);
  if (!SUPPORTED_CHANNEL_VISIBILITY.has(visibility)) {
    throw new Error(`channels.${name}.visibility must be one of ephemeral, protected, public, or internal`);
  }
  const accessControl = normalizeAccessControl(channel, name);
  const edgeAuth = normalizeEdgeAuth(channel, name, accessControl);
  const normalized = {
    name,
    visibility,
    requiresAuth: optionalBoolean(channel.requires_auth, accessControl !== "none"),
    requiresControlledAccess: accessControl !== "none",
    noindex: optionalBoolean(channel.noindex, name !== "production"),
    promotable: optionalBoolean(channel.promotable, name === "staging"),
    canonical: optionalBoolean(channel.canonical, name === "production"),
    accessControl,
    edgeAuth,
  };
  if (hasUrl) {
    normalized.url = assertString(channel.url, `channels.${name}.url`);
  }
  if (hasUrlPattern) {
    normalized.urlPattern = assertString(channel.url_pattern, `channels.${name}.url_pattern`);
  }
  return normalized;
}

function normalizeAccessControl(channel, name) {
  if (channel.access_control !== undefined) {
    const accessControl = assertString(channel.access_control, `channels.${name}.access_control`);
    if (!SUPPORTED_ACCESS_CONTROL.has(accessControl)) {
      throw new Error(`channels.${name}.access_control must be one of none, managed-network, edge-basic-auth, oidc, or app-auth`);
    }
    return accessControl;
  }
  if (name === "staging") {
    return "edge-basic-auth";
  }
  if (name === "production") {
    return "none";
  }
  return "none";
}

function normalizeEdgeAuth(channel, name, accessControl) {
  if (channel.edge_auth !== undefined) {
    const edgeAuth = assertString(channel.edge_auth, `channels.${name}.edge_auth`);
    if (!SUPPORTED_EDGE_AUTH.has(edgeAuth)) {
      throw new Error(`channels.${name}.edge_auth must be one of none, cloudfront-basic-auth, oidc, or app-auth`);
    }
    return edgeAuth;
  }
  return accessControl === "edge-basic-auth"
    ? "cloudfront-basic-auth"
    : "none";
}

function defaultChannelVisibility(name) {
  if (name === "preview") {
    return "ephemeral";
  }
  if (name === "staging") {
    return "protected";
  }
  if (name === "production") {
    return "public";
  }
  return "internal";
}

function normalizeDeploySection(deploy) {
  assertPlainObject(deploy, "deploy");
  return Object.fromEntries(
    Object.entries(deploy).map(([name, config]) => [
      name,
      normalizeDeployConfig(name, config),
    ]),
  );
}

function normalizeDeployConfig(name, config) {
  assertPlainObject(config, `deploy.${name}`);
  const adapter = assertString(config.adapter, `deploy.${name}.adapter`);
  if (!SUPPORTED_DEPLOY_ADAPTERS.has(adapter)) {
    throw new Error(`deploy.${name}.adapter must be one of aws-s3-cloudfront, aws-elastic-beanstalk, or aws-ecs-service`);
  }
  const normalized = {
    ...config,
    adapter,
    artifactPath: config.artifact_path === undefined
      ? undefined
      : posixPath(assertString(config.artifact_path, `deploy.${name}.artifact_path`)),
    secretRefs: normalizeStringArray(config.secret_refs, `deploy.${name}.secret_refs`),
    surfaces: config.surfaces === undefined
      ? undefined
      : normalizeDeploySurfaceOverrides(name, config.surfaces),
  };
  delete normalized.artifact_path;
  delete normalized.secret_refs;
  if (normalized.surfaces === undefined) {
    delete normalized.surfaces;
  }
  assertNoInlineSecretValues(config, `deploy.${name}`, new Set(["secret_refs", "surfaces"]));
  return normalized;
}

function normalizeDeploySurfaceOverrides(channelName, surfaces) {
  assertPlainObject(surfaces, `deploy.${channelName}.surfaces`);
  return Object.fromEntries(
    Object.entries(surfaces).map(([surfaceName, override]) => [
      surfaceName,
      normalizeDeploySurfaceOverride(channelName, surfaceName, override),
    ]),
  );
}

function normalizeDeploySurfaceOverride(channelName, surfaceName, override) {
  assertPlainObject(override, `deploy.${channelName}.surfaces.${surfaceName}`);
  const label = `deploy.${channelName}.surfaces.${surfaceName}`;
  const normalized = {
    ...override,
    artifactPath: override.artifact_path === undefined
      ? undefined
      : posixPath(assertString(override.artifact_path, `${label}.artifact_path`)),
    originPath: override.origin_path === undefined
      ? undefined
      : assertString(override.origin_path, `${label}.origin_path`),
    secretRefs: normalizeStringArray(override.secret_refs, `${label}.secret_refs`),
  };
  delete normalized.artifact_path;
  delete normalized.origin_path;
  delete normalized.secret_refs;
  if (normalized.artifactPath === undefined) {
    delete normalized.artifactPath;
  }
  if (normalized.originPath === undefined) {
    delete normalized.originPath;
  }
  if (normalized.secretRefs.length === 0) {
    delete normalized.secretRefs;
  }
  assertNoInlineSecretValues(override, label, new Set(["secret_refs"]));
  return normalized;
}

function assertNoInlineSecretValues(config, label, ignoredKeys = new Set()) {
  for (const [key, value] of Object.entries(config)) {
    if (ignoredKeys.has(key) || key.endsWith("_ref") || key.endsWith("_refs")) {
      continue;
    }
    if (/(secret|token|password)/i.test(key) && value !== undefined) {
      throw new Error(`${label}.${key} must be declared as a secret reference, not a secret value`);
    }
  }
}

function normalizeSurfacesSection(surfaces) {
  assertPlainObject(surfaces, "surfaces");
  const entries = Object.entries(surfaces);
  if (entries.length === 0) {
    throw new Error("surfaces must declare at least one surface");
  }
  return Object.fromEntries(
    entries.map(([name, surface]) => [
      name,
      normalizeSurfaceConfig(name, surface),
    ]),
  );
}

function normalizeSurfaceConfig(name, surface) {
  assertPlainObject(surface, `surfaces.${name}`);
  const normalized = {
    name,
    path: surface.path === undefined
      ? "/"
      : normalizeSurfacePath(assertString(surface.path, `surfaces.${name}.path`)),
    pathOnly: optionalBoolean(surface.path_only, false),
    canonical: optionalBoolean(surface.canonical, name === "default" || name === "hub"),
  };
  if (surface.preview_url_pattern !== undefined) {
    normalized.previewUrlPattern = assertString(surface.preview_url_pattern, `surfaces.${name}.preview_url_pattern`);
  }
  if (surface.staging_url !== undefined) {
    normalized.stagingUrl = assertString(surface.staging_url, `surfaces.${name}.staging_url`);
  }
  if (surface.production_url !== undefined) {
    normalized.productionUrl = assertString(surface.production_url, `surfaces.${name}.production_url`);
  }
  return normalized;
}

function normalizeSurfacePath(value) {
  const normalized = `/${String(value).replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  if (normalized === "/") {
    return normalized;
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function normalizeRetentionSection(retention) {
  assertPlainObject(retention, "retention");
  return Object.fromEntries(
    Object.entries(retention).map(([name, config]) => [
      name,
      normalizeRetentionConfig(name, config),
    ]),
  );
}

function normalizeRetentionConfig(name, config) {
  assertPlainObject(config, `retention.${name}`);
  const normalized = {};
  for (const [key, value] of Object.entries(config)) {
    const numberValue = Number(value);
    if (!Number.isInteger(numberValue) || numberValue < 0) {
      throw new Error(`retention.${name}.${key} must be a non-negative integer`);
    }
    normalized[key] = numberValue;
  }
  return normalized;
}

function normalizeSecuritySection(security) {
  assertPlainObject(security, "security");
  return Object.fromEntries(
    Object.entries(security).map(([name, config]) => [
      name,
      normalizeSecurityConfig(name, config),
    ]),
  );
}

function normalizeSecurityConfig(name, config) {
  assertPlainObject(config, `security.${name}`);
  return {
    requiresAuth: optionalBoolean(config.requires_auth, undefined),
    noindex: optionalBoolean(config.noindex, undefined),
    isolatedProviders: optionalBoolean(config.isolated_providers, undefined),
    sandboxData: optionalBoolean(config.sandbox_data, undefined),
    secretRefs: normalizeStringArray(config.secret_refs, `security.${name}.secret_refs`),
  };
}

function validateWebSurfaceConfig(config) {
  if (config.project?.type !== "web-surface") {
    return;
  }
  for (const name of WEB_SURFACE_CHANNELS) {
    if (!config.channels?.[name]) {
      throw new Error(`project.type = "web-surface" requires channels.${name}`);
    }
    if (!config.deploy?.[name]) {
      throw new Error(`project.type = "web-surface" requires deploy.${name}`);
    }
  }
  if (!config.channels.preview.urlPattern) {
    throw new Error("channels.preview.url_pattern is required for web-surface preview aliases");
  }
  for (const name of ["staging", "production"]) {
    if (!config.channels[name].url) {
      throw new Error(`channels.${name}.url is required for web-surface`);
    }
  }
  if (config.channels.staging.visibility === "public") {
    throw new Error("channels.staging.visibility must not be public for web-surface");
  }
  if (config.channels.staging.accessControl === "none") {
    throw new Error("channels.staging.access_control must protect staging for web-surface");
  }
  if (config.channels.staging.accessControl === "edge-basic-auth" && config.channels.staging.edgeAuth === "none") {
    throw new Error("channels.staging.edge_auth must not be none when access_control = edge-basic-auth");
  }
  if (!config.channels.staging.noindex) {
    throw new Error("channels.staging.noindex must be true for web-surface");
  }
  const stagingSecurity = config.security?.staging;
  if (stagingSecurity) {
    if (stagingSecurity.noindex === false) {
      throw new Error("security.staging.noindex must not disable staging noindex");
    }
    if (stagingSecurity.isolatedProviders === false) {
      throw new Error("security.staging.isolated_providers must not be false for web-surface");
    }
  }
  validateWebSurfaceSurfaces(config);
}

function validateInfraContractConfig(config) {
  if (config.project?.type !== "infra-contract") {
    return;
  }
  if (!config.infra) {
    throw new Error('project.type = "infra-contract" requires [infra]');
  }
  if (config.infra.desired.length === 0) {
    throw new Error('project.type = "infra-contract" requires infra.desired');
  }
  if (config.infra.contract.length === 0) {
    throw new Error('project.type = "infra-contract" requires infra.contract');
  }
  if (!Array.isArray(config.consumers) || config.consumers.length === 0) {
    throw new Error('project.type = "infra-contract" requires at least one [[consumers]] entry');
  }
  if (config.infra.applyMode !== "disabled" && config.infra.adoptionMode !== "managed-apply") {
    throw new Error("infra.apply requires infra.adoption_mode = managed-apply");
  }
  if (config.infra.applyMode !== "disabled" && !config.infra.environment) {
    throw new Error("infra.apply requires infra.environment");
  }
  if (config.infra.applyMode !== "disabled" && !config.infra.identityRef) {
    throw new Error("infra.apply requires infra.identity_ref");
  }
  if (config.infra.adapter === "manual-observed" && config.infra.applyMode !== "disabled") {
    throw new Error('infra.adapter = "manual-observed" requires infra.apply = "disabled"');
  }
}

function validateWebSurfaceSurfaces(config) {
  const surfaces = config.surfaces || {};
  for (const [name, surface] of Object.entries(surfaces)) {
    if (!surface.pathOnly && !surface.previewUrlPattern) {
      throw new Error(`surfaces.${name}.preview_url_pattern is required unless path_only = true`);
    }
    if (!surface.pathOnly && !surface.stagingUrl) {
      throw new Error(`surfaces.${name}.staging_url is required unless path_only = true`);
    }
    if (!surface.pathOnly && !surface.productionUrl) {
      throw new Error(`surfaces.${name}.production_url is required unless path_only = true`);
    }
    if (surface.productionUrl && !surface.pathOnly && !surface.stagingUrl) {
      throw new Error(`surfaces.${name}.staging_url is required when production_url declares a first-class host`);
    }
  }
}

function normalizeVersionSection(version) {
  assertPlainObject(version, "version");
  const files = version.files === undefined ? [] : version.files;
  if (!Array.isArray(files)) {
    throw new Error("version.files must be an array of tables");
  }
  const strategy = version.strategy === undefined
    ? "semver"
    : assertString(version.strategy, "version.strategy");
  if (!SUPPORTED_VERSION_STRATEGIES.has(strategy)) {
    throw new Error("version.strategy must be one of semver or anchored");
  }
  const next = version.next === undefined
    ? "auto"
    : assertString(version.next, "version.next");
  if (!SUPPORTED_VERSION_NEXT.has(next)) {
    throw new Error("version.next must be one of auto or manual");
  }
  if (strategy === "semver" && next !== "auto") {
    throw new Error('version.next = "manual" requires version.strategy = "anchored"');
  }
  if (strategy === "anchored" && next !== "manual") {
    throw new Error('version.strategy = "anchored" requires version.next = "manual"');
  }
  return {
    required: version.required === undefined ? false : Boolean(version.required),
    strategy,
    next,
    manifest: version.manifest === undefined
      ? undefined
      : posixPath(assertString(version.manifest, "version.manifest")),
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

export function normalizeLifecycleStage(stage, label = "lifecycle stage", lifecycle = {}) {
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

export function getLifecycleStage(loadedConfig, name) {
  return loadedConfig?.config?.lifecycle?.[name];
}

export function getPublishContract(loadedConfig) {
  return loadedConfig?.config?.publish;
}

export function runLifecycleStage({ cwd = process.cwd(), loadedConfig, name, stage, env: extraEnv }) {
  const lifecycle = loadedConfig?.config?.lifecycle || {};
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

export function discoverConfiguredVersionStateFiles(cwd = process.cwd(), loadedConfig = loadBuildchainConfig(cwd)) {
  const configured = loadedConfig?.config?.version?.files || [];
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
    if (typeof match.groups?.version !== "string") {
      throw new Error(`Configured regex version pattern must define a named capture group called version: ${entry.path}`);
    }
    return { ...file, pattern };
  });
  if (loadedConfig?.config?.version?.required && files.length === 0) {
    throw new Error("version.required is true but no version.files are configured");
  }
  return files;
}

function summarizeManifestFields(content) {
  assertPlainObject(content, "version.manifest content");
  return Object.fromEntries(
    Object.entries(content).map(([key, value]) => {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        return [key, value];
      }
      return [key, JSON.stringify(value)];
    }),
  );
}

export function getVersionStrategy(loadedConfig) {
  const version = loadedConfig?.config?.version;
  return {
    strategy: version?.strategy || "semver",
    next: version?.next || "auto",
    manifest: version?.manifest,
  };
}

export function loadConfiguredAnchorManifest(cwd = process.cwd(), loadedConfig = loadBuildchainConfig(cwd)) {
  const manifest = loadedConfig?.config?.version?.manifest;
  if (!manifest) {
    return undefined;
  }
  const filePath = path.join(cwd, manifest);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Configured anchor manifest does not exist: ${manifest}`);
  }
  const source = fs.readFileSync(filePath, "utf8");
  let content;
  if (manifest.endsWith(".json")) {
    content = JSON.parse(source);
  } else if (manifest.endsWith(".toml")) {
    content = parse(source);
  } else {
    throw new Error("version.manifest must point to a .json or .toml file");
  }
  return {
    path: manifest,
    filePath,
    fields: summarizeManifestFields(content),
  };
}

function configuredLifecycleStages(loadedConfig) {
  const lifecycle = loadedConfig?.config?.lifecycle || {};
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

export function validateBuildchainConfig(
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
  const anchorManifest = loadConfiguredAnchorManifest(cwd, loadedConfig);
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
    project: loadedConfig.config.project,
    channels: loadedConfig.config.channels
      ? Object.fromEntries(
          Object.entries(loadedConfig.config.channels).map(([name, channel]) => [
            name,
            {
              visibility: channel.visibility,
              requiresAuth: channel.requiresAuth,
              requiresControlledAccess: channel.requiresControlledAccess,
              accessControl: channel.accessControl,
              edgeAuth: channel.edgeAuth,
              noindex: channel.noindex,
              promotable: channel.promotable,
              canonical: channel.canonical,
              url: channel.url,
              urlPattern: channel.urlPattern,
            },
          ]),
        )
      : undefined,
    deploy: loadedConfig.config.deploy
      ? Object.fromEntries(
          Object.entries(loadedConfig.config.deploy).map(([name, deploy]) => [
            name,
            {
              adapter: deploy.adapter,
              artifactPath: deploy.artifactPath,
              secretRefs: deploy.secretRefs,
            },
          ]),
        )
      : undefined,
    infra: loadedConfig.config.infra
      ? {
          adapter: loadedConfig.config.infra.adapter,
          adoptionMode: loadedConfig.config.infra.adoptionMode,
          applyMode: loadedConfig.config.infra.applyMode,
          environment: loadedConfig.config.infra.environment,
          identityRef: loadedConfig.config.infra.identityRef,
          desired: loadedConfig.config.infra.desired,
          contract: loadedConfig.config.infra.contract,
          secretRefs: loadedConfig.config.infra.secretRefs,
          commands: loadedConfig.config.infra.commands,
        }
      : undefined,
    consumers: loadedConfig.config.consumers,
    surfaces: loadedConfig.config.surfaces
      ? Object.fromEntries(
          Object.entries(loadedConfig.config.surfaces).map(([name, surface]) => [
            name,
            {
              path: surface.path,
              pathOnly: surface.pathOnly,
              canonical: surface.canonical,
              previewUrlPattern: surface.previewUrlPattern,
              stagingUrl: surface.stagingUrl,
              productionUrl: surface.productionUrl,
            },
          ]),
        )
      : undefined,
    retention: loadedConfig.config.retention,
    security: loadedConfig.config.security,
    version: loadedConfig.config.version
      ? getVersionStrategy(loadedConfig)
      : undefined,
    anchorManifest: anchorManifest
      ? {
          path: anchorManifest.path,
          fields: anchorManifest.fields,
        }
      : undefined,
    versionFiles: versionFiles.map((file) => ({
      path: file.path,
      type: file.type,
      key: file.key,
      pattern: file.pattern?.source,
    })),
    lifecycleStages,
    publish: loadedConfig.config.publish,
  };
}

export function updateConfiguredVersionStateContents(files, version) {
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
          const groups = args.at(-1) || {};
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

export function writeLifecycleScriptFixture(cwd, name, script) {
  const filePath = path.join(cwd, `${name}-${Date.now()}.sh`);
  fs.writeFileSync(filePath, script.replace(/\$\{TMPDIR\}/g, os.tmpdir()));
  return filePath;
}

export default {
  discoverConfiguredVersionStateFiles,
  getVersionStrategy,
  getLifecycleStage,
  loadConfiguredAnchorManifest,
  loadBuildchainConfig,
  normalizeBuildchainConfig,
  normalizeLifecycleStage,
  runLifecycleStage,
  updateConfiguredVersionStateContents,
  validateBuildchainConfig,
  writeLifecycleScriptFixture,
};
