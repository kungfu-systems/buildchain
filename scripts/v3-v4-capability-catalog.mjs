import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const FIXED_GENERATED_CONTRACTS = Object.freeze([
  "dist/site/buildchain-contract.json",
  "dist/site/capability-registry.json",
  "dist/site/cli-registry.json",
  "dist/site/controller-registry.json",
  "dist/site/kfd-claims.json",
  "dist/site/manual-registry.json",
  "dist/site/node-api-registry.json",
  "dist/site/page-registry.json",
  "dist/site/public-surface-audit.json",
  "dist/site/release-model.json",
  "dist/site/release-passport-check-manifest.json",
  "dist/site/site-manifest.json",
  "dist/site/workflow-registry.json",
]);

const PLATFORM_MARKERS = Object.freeze({
  linux: /\b(?:ubuntu|linux)\b/iu,
  macos: /\bmacos\b/iu,
  "self-hosted": /\bself-hosted\b/iu,
  windows: /\bwindows\b/iu,
});

export function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJson(entry)]),
  );
}

export function git(root, args, { trim = true } = {}) {
  const output = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return trim ? output.trim() : output;
}

function gitJson(root, revision, relPath) {
  return JSON.parse(
    git(root, ["show", `${revision}:${relPath}`], { trim: false }),
  );
}

function gitText(root, revision, relPath) {
  return git(root, ["show", `${revision}:${relPath}`], { trim: false });
}

function gitPaths(root, revision) {
  return git(root, ["ls-tree", "-r", "--name-only", revision])
    .split("\n")
    .filter(Boolean)
    .sort();
}

function catalogEntry({ category, identity, path: relPath, selector, value }) {
  return {
    id: `${category}:${identity}`,
    category,
    identity,
    evidence: {
      path: relPath,
      selector,
      valueRoot: sha256(JSON.stringify(stableJson(value))),
    },
  };
}

function add(catalog, entry) {
  if (catalog.has(entry.id))
    throw new Error(`duplicate capability identity: ${entry.id}`);
  catalog.set(entry.id, entry);
}

function values(entries) {
  return (entries || [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter(Boolean);
}

function addNodeCatalog(catalog, packageJson, nodeRegistry) {
  for (const [exportName, target] of Object.entries(
    packageJson.exports || {},
  )) {
    add(
      catalog,
      catalogEntry({
        category: "node-export",
        identity: exportName,
        path: "package.json",
        selector: `exports[${JSON.stringify(exportName)}]`,
        value: target,
      }),
    );
  }
  const symbolNames = new Map(
    (nodeRegistry.symbols || []).map((symbol) => [symbol.id, symbol.name]),
  );
  for (const entry of nodeRegistry.exports || []) {
    add(
      catalog,
      catalogEntry({
        category: "documented-module",
        identity: entry.export,
        path: "dist/site/node-api-registry.json",
        selector: `exports[export=${JSON.stringify(entry.export)}]`,
        value: {
          target: entry.target,
          summary: entry.summary,
          digest: entry.digest,
        },
      }),
    );
    for (const symbolId of entry.symbolIds || []) {
      const name = symbolNames.get(symbolId);
      if (!name)
        throw new Error(
          `node registry export ${entry.export} references unknown symbol ${symbolId}`,
        );
      add(
        catalog,
        catalogEntry({
          category: "node-symbol",
          identity: `${entry.export}#${name}`,
          path: "dist/site/node-api-registry.json",
          selector: `exports[export=${JSON.stringify(entry.export)}].symbolIds[name=${JSON.stringify(name)}]`,
          value: name,
        }),
      );
    }
  }
}

function addCliCatalog(catalog, cliRegistry) {
  for (const command of cliRegistry.commands || []) {
    add(
      catalog,
      catalogEntry({
        category: "cli-command",
        identity: command.id,
        path: "dist/site/cli-registry.json",
        selector: `commands[id=${JSON.stringify(command.id)}]`,
        value: { paths: command.paths, usage: command.usage },
      }),
    );
    for (const option of command.options || []) {
      add(
        catalog,
        catalogEntry({
          category: "cli-option",
          identity: `${command.id}#${option}`,
          path: "dist/site/cli-registry.json",
          selector: `commands[id=${JSON.stringify(command.id)}].options[${JSON.stringify(option)}]`,
          value: option,
        }),
      );
    }
  }
}

function addWorkflowInterface(catalog, workflow, category, field) {
  for (const name of values(workflow[field])) {
    add(
      catalog,
      catalogEntry({
        category,
        identity: `${workflow.id}#${name}`,
        path: "dist/site/workflow-registry.json",
        selector: `workflows[id=${JSON.stringify(workflow.id)}].${field}[${JSON.stringify(name)}]`,
        value: name,
      }),
    );
  }
}

function addWorkflowCatalog(catalog, workflowRegistry) {
  for (const workflow of workflowRegistry.workflows || []) {
    add(
      catalog,
      catalogEntry({
        category: "workflow",
        identity: workflow.id,
        path: "dist/site/workflow-registry.json",
        selector: `workflows[id=${JSON.stringify(workflow.id)}]`,
        value: { path: workflow.path, reusable: workflow.reusable },
      }),
    );
    for (const [category, field] of [
      ["workflow-input", "inputs"],
      ["workflow-output", "outputs"],
      ["workflow-secret", "secrets"],
    ]) {
      addWorkflowInterface(catalog, workflow, category, field);
    }
  }
  for (const action of workflowRegistry.actions || []) {
    add(
      catalog,
      catalogEntry({
        category: "action",
        identity: action.id,
        path: "dist/site/workflow-registry.json",
        selector: `actions[id=${JSON.stringify(action.id)}]`,
        value: action.path,
      }),
    );
    for (const name of values(action.inputs)) {
      add(
        catalog,
        catalogEntry({
          category: "action-input",
          identity: `${action.id}#${name}`,
          path: "dist/site/workflow-registry.json",
          selector: `actions[id=${JSON.stringify(action.id)}].inputs[${JSON.stringify(name)}]`,
          value: name,
        }),
      );
    }
  }
}

function addFileEntry(catalog, root, revision, category, relPath) {
  add(
    catalog,
    catalogEntry({
      category,
      identity: relPath,
      path: relPath,
      selector: "$",
      value: sha256(gitText(root, revision, relPath)),
    }),
  );
}

function addFileCatalog(catalog, root, revision, paths, pathSet) {
  const schemas = paths.filter(
    (entry) =>
      entry.startsWith("contracts/") &&
      entry.endsWith(".schema.json") &&
      !entry.includes("/fixtures/"),
  );
  const configs = paths.filter((entry) =>
    /^\.buildchain\/.*\.(?:json|toml)$/u.test(entry),
  );
  const generated = new Set([
    ...FIXED_GENERATED_CONTRACTS.filter((entry) => pathSet.has(entry)),
    ...paths.filter(
      (entry) =>
        entry.startsWith("dist/site/schemas/") &&
        entry.endsWith(".schema.json"),
    ),
  ]);
  const evidence = paths.filter(
    (entry) =>
      entry.startsWith("contracts/") &&
      !entry.includes("/fixtures/") &&
      /(?:evidence|passport|receipt|attestation|witness)/u.test(entry),
  );
  for (const relPath of schemas)
    addFileEntry(catalog, root, revision, "source-schema", relPath);
  for (const relPath of configs)
    addFileEntry(catalog, root, revision, "config-contract", relPath);
  for (const relPath of [...generated].sort())
    addFileEntry(catalog, root, revision, "generated-contract", relPath);
  for (const relPath of evidence)
    addFileEntry(
      catalog,
      root,
      revision,
      "observable-evidence-contract",
      relPath,
    );
}

function addMechanismCatalog(
  catalog,
  mechanismInventory,
  capabilityManifest,
  isLiveV3,
) {
  const mechanisms = isLiveV3
    ? mechanismInventory.mechanisms || []
    : capabilityManifest.capabilities || [];
  const relPath = isLiveV3
    ? "architecture/v3-core-mechanism-inventory.json"
    : "architecture/v4-capability-state-machine-manifest.json";
  for (const mechanism of mechanisms) {
    add(
      catalog,
      catalogEntry({
        category: "release-delivery-recovery",
        identity: mechanism.id,
        path: relPath,
        selector: `capability[id=${JSON.stringify(mechanism.id)}]`,
        value: mechanism,
      }),
    );
  }
}

function addPlatformCatalog(catalog, root, revision, paths) {
  const workflowText = paths
    .filter(
      (entry) =>
        entry.startsWith(".github/workflows/") && /\.ya?ml$/u.test(entry),
    )
    .map((entry) => gitText(root, revision, entry))
    .join("\n");
  for (const [platform, pattern] of Object.entries(PLATFORM_MARKERS)) {
    if (!pattern.test(workflowText)) continue;
    add(
      catalog,
      catalogEntry({
        category: "platform-branch",
        identity: platform,
        path: ".github/workflows",
        selector: `runner-marker:${platform}`,
        value: platform,
      }),
    );
  }
}

export function collectRevisionCatalog({ root, revision, liveV3Revision }) {
  const catalog = new Map();
  const paths = gitPaths(root, revision);
  const pathSet = new Set(paths);
  const packageJson = gitJson(root, revision, "package.json");
  const nodeRegistry = gitJson(
    root,
    revision,
    "dist/site/node-api-registry.json",
  );
  const cliRegistry = gitJson(root, revision, "dist/site/cli-registry.json");
  const workflowRegistry = gitJson(
    root,
    revision,
    "dist/site/workflow-registry.json",
  );
  const mechanismInventory = gitJson(
    root,
    revision,
    "architecture/v3-core-mechanism-inventory.json",
  );
  const capabilityManifest = gitJson(
    root,
    revision,
    "architecture/v4-capability-state-machine-manifest.json",
  );
  addNodeCatalog(catalog, packageJson, nodeRegistry);
  addCliCatalog(catalog, cliRegistry);
  addWorkflowCatalog(catalog, workflowRegistry);
  addFileCatalog(catalog, root, revision, paths, pathSet);
  addMechanismCatalog(
    catalog,
    mechanismInventory,
    capabilityManifest,
    revision === liveV3Revision,
  );
  addPlatformCatalog(catalog, root, revision, paths);
  return { catalog, paths: pathSet };
}

export function collectHistoryRows({
  root,
  priorRevision,
  liveV3Revision,
  v4Paths,
  migrationPaths,
  ownerAssignment,
}) {
  const output = git(root, [
    "diff",
    "--name-status",
    priorRevision,
    liveV3Revision,
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const sourcePath = fields.at(-1);
      const migrationPath = migrationPaths.get(sourcePath);
      if (!v4Paths.has(sourcePath) && !migrationPath)
        throw new Error(
          `unclassified post-family v3 history path: ${sourcePath}`,
        );
      if (migrationPath && !v4Paths.has(migrationPath))
        throw new Error(
          `history migration route is absent from the exact v4 cut: ${migrationPath}`,
        );
      return {
        id: `history-change:${sourcePath}`,
        category: "history-change",
        disposition: migrationPath ? "executable-migration" : "v4-native",
        ownerAssignment,
        sourceEvidence: {
          path: sourcePath,
          selector: `git-diff-status:${fields[0]}`,
          valueRoot: sha256(line),
        },
        v4Route: {
          capabilityId: `path:${migrationPath || sourcePath}`,
          evidence: { path: migrationPath || sourcePath, selector: "$" },
        },
        residual: null,
        positiveProbe:
          "the exact v3 history range includes the path and the exact v4 cut contains its route",
        negativeProbe:
          "an absent or unclassified changed path fails validation",
      };
    });
}

export function countsBy(rows, field) {
  return Object.fromEntries(
    [...new Set(rows.map((row) => row[field]))]
      .sort()
      .map((value) => [
        value,
        rows.filter((row) => row[field] === value).length,
      ]),
  );
}
