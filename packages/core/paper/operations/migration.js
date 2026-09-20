import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import YAML from "yaml";
import {
  consumerAgentInstructions,
  consumerConfiguration,
} from "../../adoption/consumer-init.js";
import { consumerWorkflows } from "../../consumer/contract/entries.js";
import { compileConsumerPlan } from "../../consumer/contract/plan.js";
import { validateConsumerWiring } from "../../consumer/contract/local-validation.js";
import {
  loadBuildchainConfig,
  validateBuildchainConfig,
} from "../../consumer/buildchain-config.js";
import {
  gitResult,
  gitValue,
  PAPER_PATHS,
  sha256Text,
  stableJson,
} from "../paper-repository.js";
import { buildchainPackageIdentity } from "./runtime.js";
import {
  BUILDCHAIN_PACKAGE_NAME,
  PAPER_MIGRATION_CONTRACT,
} from "./identity.js";
import { jsonText } from "./files.js";

const LEGACY_WORKFLOWS = new Map([
  ["build.yml", ["public-build-publication.yml", ".build-publication.yml"]],
  [
    ".build-candidate.yml",
    ["public-build-publication.yml", ".build-publication.yml"],
  ],
  ["verify.yml", ["public-build-check.yml", ".build-check.yml"]],
  [
    "public-release-paper.yml",
    ["public-release-paper.yml", ".release-paper.yml"],
  ],
  [".release-paper.yml", ["public-release-paper.yml", ".release-paper.yml"]],
]);
const LEGACY_SCRIPTS = {
  "buildchain:paper": "buildchain paper",
  "paper:preflight": "buildchain paper preflight --json",
  "paper:agent:verify": "buildchain paper agent verify --json",
  "paper:work:start": "buildchain paper work start",
  "paper:work:submit": "buildchain paper work submit",
  "paper:status": "buildchain paper status --json",
};

export function paperFileTarget(cwd, relative) {
  const parts = relative.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const target = path.join(cwd, ...parts.slice(0, index));
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (
      stat &&
      (stat.isSymbolicLink() ||
        (index < parts.length ? !stat.isDirectory() : !stat.isFile()))
    )
      throw new Error(
        `${relative}: Paper scaffold requires regular files and directories`,
      );
  }
  return path.join(cwd, relative);
}

function regularSource(cwd, relative) {
  const absolute = paperFileTarget(cwd, relative);
  return fs.existsSync(absolute)
    ? fs.readFileSync(absolute, "utf8")
    : undefined;
}

function retireWorkflows(cwd, files) {
  regularSource(cwd, ".github/workflows/buildchain.yml");
  const directory = path.join(cwd, ".github/workflows");
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!/\.ya?ml$/iu.test(entry.name) && entry.isFile()) continue;
    const relative = `.github/workflows/${entry.name}`;
    const source = regularSource(cwd, relative);
    if (files.has(relative)) {
      if (source !== files.get(relative))
        throw new Error(`Existing shared caller differs: ${relative}`);
      continue;
    }
    const callees = LEGACY_WORKFLOWS.get(entry.name);
    const workflow = YAML.parse(source);
    const jobs = Object.values(workflow?.jobs || {});
    if (
      !callees ||
      !jobs.length ||
      jobs.some((job) => {
        const match =
          typeof job?.uses === "string" &&
          /^kungfu-systems\/buildchain\/\.github\/workflows\/([^@]+)@(v[34](?:-alpha)?|[0-9a-f]{40})$/u.exec(
            job.uses,
          );
        return (
          !match ||
          !callees.includes(match[1]) ||
          Object.hasOwn(job, "steps") ||
          Object.hasOwn(job, "runs-on")
        );
      })
    )
      throw new Error(
        `Unowned or customized Paper workflow requires explicit product migration: ${relative}`,
      );
    files.set(relative, null);
  }
}

function retireControl(cwd, files, relative, contract, digestKey) {
  const source = regularSource(cwd, relative);
  if (source === undefined) return;
  const value = JSON.parse(source);
  const { [digestKey]: digest, ...payload } = value;
  if (value.contract !== contract || digest !== sha256Text(stableJson(payload)))
    throw new Error(
      `Cannot retire an unverified Paper control file: ${relative}`,
    );
  files.set(relative, null);
}

function productCommands(config, stage) {
  const lifecycle = config.lifecycle || {};
  const value = lifecycle[stage];
  if (
    !value?.commands?.length ||
    value.shell ||
    Object.keys(value.env || {}).length ||
    Object.keys(lifecycle.env || {}).length ||
    value.timeoutMinutes ||
    value.retries !== 1
  )
    throw new Error(
      `Move ${stage} shell, environment, retry and script settings into product commands before Paper migration`,
    );
  return value.commands;
}

function migratedPackage(current, config, runtimeVersion) {
  if (current.version && current.version !== config.publication.version)
    throw new Error(
      "Paper package and publication versions disagree; migration cannot choose a version authority",
    );
  const scripts = { ...(current.scripts || {}) };
  for (const [name, command] of Object.entries(LEGACY_SCRIPTS)) {
    if (scripts[name] !== undefined && scripts[name] !== command)
      throw new Error(
        `Customized managed Paper script requires explicit migration: ${name}`,
      );
    delete scripts[name];
  }
  return {
    ...current,
    private: true,
    version: config.publication.version,
    description: current.description || config.publication.title,
    scripts,
    devDependencies: {
      ...(current.devDependencies || {}),
      "@kungfu-tech/buildchain": runtimeVersion,
    },
  };
}

export function migrationFiles({ cwd, buildchainRoot, buildchainVersion }) {
  regularSource(cwd, PAPER_PATHS.config);
  const loaded = loadBuildchainConfig(cwd);
  const instructions = consumerAgentInstructions(
    regularSource(cwd, "AGENTS.md") || "",
  );
  if (loaded?.config.schema === 2) {
    validateBuildchainConfig(cwd, {
      requireLifecycleStages: ["build", "verify"],
    });
    if (!loaded.config.products.some((product) => product.type === "paper"))
      throw new Error("Paper migration requires a Paper product");
    validateConsumerWiring(cwd, loaded.path);
    const files = new Map([["AGENTS.md", instructions]]);
    const packageText = regularSource(cwd, "package.json");
    const sourcePackage =
      packageText === undefined ? null : JSON.parse(packageText);
    if (sourcePackage?.devDependencies?.["@kungfu-tech/buildchain"]) {
      const version = buildchainPackageIdentity(
        buildchainRoot,
        buildchainVersion,
      ).version;
      if (!/^4\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
        throw new Error("Paper migration requires an exact v4 CLI dependency");
      sourcePackage.devDependencies["@kungfu-tech/buildchain"] = version;
      files.set("package.json", jsonText(sourcePackage));
      const workspace = regularSource(cwd, PAPER_PATHS.pnpmWorkspace);
      if (workspace !== undefined)
        files.set(
          PAPER_PATHS.pnpmWorkspace,
          paperPnpmWorkspace(workspace, version),
        );
    }
    return files;
  }
  const config = loaded?.config;
  if (
    config?.project?.type !== "publication-artifact" ||
    config.publication?.kind !== "paper"
  )
    throw new Error(
      "Paper migration requires a schema-1 Paper publication or a schema-2 Paper product",
    );
  const raw = parse(regularSource(cwd, PAPER_PATHS.config));
  const allowed = new Set([
    "schema",
    "project",
    "publication",
    "publish",
    "lifecycle",
    "next_development",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key)))
    throw new Error(
      "Paper migration cannot discard additional configuration sections; move them into product sources first",
    );
  const current = JSON.parse(regularSource(cwd, "package.json") || "null");
  if (!current || Array.isArray(current) || typeof current !== "object")
    throw new Error("Paper migration requires a valid source package.json");
  const runtimeVersion = buildchainPackageIdentity(
    buildchainRoot,
    buildchainVersion,
  ).version;
  if (!/^4\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(runtimeVersion))
    throw new Error("Paper migration requires an exact v4 CLI dependency");
  const plan = parse(
    consumerConfiguration({
      type: "paper",
      version: config.publication.version,
    }),
  );
  const product = plan.products[0];
  product.build = productCommands(config, "build");
  product.verify = productCommands(config, "verify");
  if (config.lifecycle.install)
    product.install = productCommands(config, "install");
  if (
    Object.keys(raw.lifecycle || {}).some(
      (key) => !["build", "verify", "install"].includes(key),
    )
  )
    throw new Error(
      "Paper migration cannot retain consumer release lifecycle hooks or global shell settings",
    );
  product.artifacts = config.publication.artifactPaths.map(
    (artifact, index) => ({
      id: index ? `pdf-${index + 1}` : "main",
      path: artifact,
      kind: "pdf",
    }),
  );
  if (product.artifacts.some((artifact) => !artifact.path.endsWith(".pdf")))
    throw new Error("Paper migration requires explicit PDF artifacts");
  product.targets[0].artifacts = product.artifacts.map(
    (artifact) => artifact.id,
  );
  const toml = stringify(plan);
  compileConsumerPlan(toml);
  const { version: _version, ...metadata } = raw.publication;
  const metadataPath = "paper/publication-metadata.json";
  const metadataBytes = jsonText({
    schema: "buildchain.paper-product-metadata/v1",
    ...metadata,
  });
  const existingMetadata = regularSource(cwd, metadataPath);
  if (existingMetadata !== undefined && existingMetadata !== metadataBytes)
    throw new Error(
      `Paper migration would overwrite product metadata: ${metadataPath}`,
    );
  const files = new Map([
    [PAPER_PATHS.config, toml],
    [
      "package.json",
      jsonText(migratedPackage(current, config, runtimeVersion)),
    ],
    ["AGENTS.md", instructions],
    [metadataPath, metadataBytes],
    ...Object.entries(consumerWorkflows()),
  ]);
  retireWorkflows(cwd, files);
  retireControl(
    cwd,
    files,
    PAPER_PATHS.provisioningAuthority,
    "kungfu-buildchain-paper-provisioning-authority",
    "authorityDigest",
  );
  retireControl(
    cwd,
    files,
    PAPER_PATHS.agentEntry,
    "kungfu-buildchain-paper-agent-entry",
    "entryDigest",
  );
  const pin = regularSource(cwd, PAPER_PATHS.versionPin);
  if (pin !== undefined) {
    if (!/^[34]\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s*$/u.test(pin))
      throw new Error("Unrecognized Paper runtime pin cannot be retired");
    files.set(PAPER_PATHS.versionPin, null);
  }
  const workspace = regularSource(cwd, PAPER_PATHS.pnpmWorkspace);
  if (workspace !== undefined)
    files.set(
      PAPER_PATHS.pnpmWorkspace,
      paperPnpmWorkspace(workspace, runtimeVersion),
    );
  // Existing channel locks and publication receipts are preserved byte-for-byte.
  return files;
}

function paperPnpmWorkspace(current, buildchainVersion) {
  const entry = `${BUILDCHAIN_PACKAGE_NAME}@${buildchainVersion}`;
  const source = String(current || "");
  const lines = source ? source.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const keyLines = lines
    .map((line, index) =>
      /^minimumReleaseAgeExclude:\s*(?:#.*)?$/.test(line) ? index : -1,
    )
    .filter((index) => index >= 0);
  const unsupportedKey = lines.some(
    (line) =>
      /^minimumReleaseAgeExclude\s*:/.test(line) &&
      !/^minimumReleaseAgeExclude:\s*(?:#.*)?$/.test(line),
  );
  if (unsupportedKey || keyLines.length > 1) {
    throw new Error(
      "paper migration requires minimumReleaseAgeExclude to be one top-level block sequence",
    );
  }
  if (keyLines.length === 0) {
    const prefix = lines.length > 0 ? [...lines, ""] : [];
    return `${[...prefix, "minimumReleaseAgeExclude:", `  - '${entry}'`].join(
      "\n",
    )}\n`;
  }
  const keyIndex = keyLines[0];
  let blockEnd = lines.length;
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    if (/^[^\s#]/.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }
  const retained = [];
  for (const line of lines.slice(keyIndex + 1, blockEnd)) {
    if (!line.trim() || /^\s*#/.test(line)) {
      retained.push(line);
      continue;
    }
    const item = line.match(/^\s*-\s+(.+?)\s*(?:#.*)?$/);
    if (!item) {
      throw new Error(
        "paper migration requires minimumReleaseAgeExclude to contain scalar package entries",
      );
    }
    const value = item[1]
      .trim()
      .replace(/^'(.*)'$/, "$1")
      .replace(/^"(.*)"$/, "$1");
    if (!value.startsWith(`${BUILDCHAIN_PACKAGE_NAME}@`)) retained.push(line);
  }
  return `${[
    ...lines.slice(0, keyIndex + 1),
    ...retained,
    `  - '${entry}'`,
    ...lines.slice(blockEnd),
  ].join("\n")}\n`;
}

export function applyPaperMigration(plan) {
  if (!plan || plan.contract !== PAPER_MIGRATION_CONTRACT) {
    throw new Error("paper migration plan contract mismatch");
  }
  if (!plan.ok) {
    return {
      ...plan,
      dryRun: false,
      written: [],
      updated: [],
      removed: [],
      ok: false,
      errorCode: "paper-migration-blocked",
    };
  }
  if (fs.realpathSync(plan.cwd) !== plan.cwd)
    throw new Error("Paper migration root changed after planning");
  if (
    gitValue(plan.cwd, ["rev-parse", "HEAD"]) !== plan.source.head ||
    gitResult(plan.cwd, ["status", "--porcelain"]).stdout !== ""
  )
    throw new Error(
      "paper migration source changed after planning; no stale plan was applied",
    );
  for (const entry of plan._plannedFiles) paperFileTarget(plan.cwd, entry.path);
  const written = [];
  const updated = [];
  const removed = [];
  for (const entry of plan._plannedFiles) {
    if (entry.action === "unchanged") continue;
    const target = path.resolve(plan.cwd, entry.path);
    const exists = fs.existsSync(target);
    const current =
      exists && fs.statSync(target).isFile()
        ? fs.readFileSync(target, "utf8")
        : undefined;
    const currentSha256 = current === undefined ? "" : sha256Text(current);
    if (
      (entry.action === "create" && exists) ||
      (["update", "remove"].includes(entry.action) &&
        currentSha256 !== entry.currentSha256)
    ) {
      throw new Error(
        `paper migration race detected at ${entry.path}; no stale plan was applied`,
      );
    }
  }
  for (const entry of plan._plannedFiles) {
    if (entry.action === "unchanged") continue;
    const target = path.resolve(plan.cwd, entry.path);
    if (entry.action === "remove") {
      fs.unlinkSync(target);
      removed.push(entry.path);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content, {
      flag: entry.action === "create" ? "wx" : "w",
    });
    (entry.action === "create" ? written : updated).push(entry.path);
  }
  return {
    ...plan,
    ok: true,
    dryRun: false,
    written,
    updated,
    removed,
    idempotent:
      written.length === 0 && updated.length === 0 && removed.length === 0,
    nextActions: [
      {
        id: "paper-preflight",
        command: `buildchain paper preflight --cwd ${JSON.stringify(plan.cwd)} --offline --json`,
        description:
          "Verify the migrated repository before any external mutation.",
      },
    ],
  };
}
