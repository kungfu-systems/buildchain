import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILDCHAIN_PUBLIC_SURFACE_AUDIT_CONTRACT = "kungfu-buildchain-public-surface-reverse-audit";

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function readJson(root, relPath, fallback = undefined) {
  const filePath = path.join(root, relPath);
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function listFiles(root, dir, predicate = () => true) {
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

function listDirectories(root, dir) {
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

function commandId(first = "", second = "") {
  const head = String(first || "").trim();
  const sub = String(second || "").trim();
  if (!head) return "";
  if (["-h", "--help", "help"].includes(head)) return "help";
  if (["-v", "--version", "version"].includes(head)) return "version";
  if (head === "release" && ["--dry-run", "dry-run", "explain"].includes(sub)) return "release-dry-run";
  if (head === "release" && sub === "line") return "release-line-open";
  if (head === "release") return "release-transaction";
  if (head === "transaction") return "transaction-inspect";
  if (head === "collect" && sub) return `collect-${sub}`;
  if (head === "verify" && sub) return `verify-${sub}`;
  if (head === "explain" && sub) return `explain-${sub}`;
  if (head === "inspect" && sub) return `inspect-${sub}`;
  if (head === "npm" && sub) return `npm-${sub}`;
  if (head === "lifecycle" && sub) return "lifecycle";
  if (head === "log" && sub) return "logging";
  if (head === "diagnostics" && sub) return `diagnostics-${sub}`;
  if (head === "facts" && sub) return "build-facts";
  if (head === "sample" && sub) return `sample-${sub}`;
  if (head === "badges" && sub) return `badges-${sub}`;
  if (head === "homebrew" && sub) return `homebrew-${sub}`;
  if (head === "release-propagation") return "release-propagation";
  if (head === "publish-source") return "publish-source";
  if (head === "build-contract") return "build-contract";
  if (head === "infra-contract") return "infra-contract";
  if (head === "web-surface") return "web-surface";
  return head;
}

export function enumerateCliCommandsFromBin({ root = process.cwd(), binPath = "bin/buildchain.mjs" } = {}) {
  const source = readText(root, binPath);
  const usageMatch = source.match(/return `Usage:\n([\s\S]*?)`;\n}/);
  const usage = usageMatch?.[1] || "";
  const usageCommands = [];
  for (const line of usage.split(/\r?\n/)) {
    const match = line.trim().match(/^buildchain\s+([^\s]+)(?:\s+([^\s]+))?/);
    if (!match) continue;
    usageCommands.push({
      id: commandId(match[1], match[2]),
      usage: line.trim().replace(/\s+/g, " "),
    });
  }
  const dispatchCommands = [...source.matchAll(/if\s*\(\s*command\s*===\s*"([^"]+)"/g)]
    .map((match) => commandId(match[1]));
  return uniqueSorted([
    ...usageCommands.map((entry) => entry.id),
    ...dispatchCommands,
  ]).map((id) => ({
    id,
    source: "bin/buildchain.mjs",
    usage: usageCommands.find((entry) => entry.id === id)?.usage || `buildchain ${id}`,
  }));
}

function parseYamlTopLevelInputs(text) {
  const lines = text.split(/\r?\n/);
  const inputs = [];
  let inInputs = false;
  let indent = 0;
  for (const line of lines) {
    const match = line.match(/^(\s*)inputs:\s*$/);
    if (match) {
      inInputs = true;
      indent = match[1].length;
      continue;
    }
    if (!inInputs) continue;
    const currentIndent = line.match(/^(\s*)/)?.[1].length || 0;
    if (line.trim() && currentIndent <= indent) {
      inInputs = false;
      continue;
    }
    const inputMatch = line.match(new RegExp(`^\\s{${indent + 2}}([A-Za-z0-9_-]+):\\s*$`));
    if (inputMatch) inputs.push(inputMatch[1]);
  }
  return uniqueSorted(inputs);
}

export function enumerateWorkflowInputs({ root = process.cwd() } = {}) {
  return listFiles(root, ".github/workflows", (name) => /\.ya?ml$/.test(name)).map((relPath) => {
    const inputs = parseYamlTopLevelInputs(readText(root, relPath));
    return {
      id: relPath.replace(/^\.github\/workflows\//, "").replace(/\.ya?ml$/, ""),
      path: relPath,
      inputs,
      inputCount: inputs.length,
    };
  });
}

export function enumerateActionInputs({ root = process.cwd() } = {}) {
  return listDirectories(root, "actions").map((dir) => {
    const relPath = `${dir}/action.yml`;
    const inputs = fs.existsSync(path.join(root, relPath))
      ? parseYamlTopLevelInputs(readText(root, relPath))
      : [];
    return {
      id: dir.replace(/^actions\//, ""),
      path: relPath,
      inputs,
      inputCount: inputs.length,
    };
  });
}

export function enumerateSitePages({ root = process.cwd() } = {}) {
  const pageRegistry = readJson(root, "dist/site/page-registry.json", {});
  return (Array.isArray(pageRegistry?.pages) ? pageRegistry.pages : []).map((page) => ({
    id: page.id || page.path,
    path: page.path,
    category: page.category || "",
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function enumerateDocCommandRefs({ root = process.cwd() } = {}) {
  const knownCommandIds = new Set(enumerateCliCommandsFromBin({ root }).map((entry) => entry.id));
  const docs = [
    "README.md",
    ...listFiles(root, "docs", (name) => name.endsWith(".md")),
    ...listDirectories(root, "actions").map((dir) => `${dir}/README.md`).filter((relPath) => fs.existsSync(path.join(root, relPath))),
  ];
  const refs = [];
  for (const relPath of docs) {
    const text = readText(root, relPath);
    const codeSegments = [];
    for (const match of text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)) {
      codeSegments.push({ kind: "block", text: match[1] });
    }
    for (const match of text.matchAll(/`([^`\n]*\bbuildchain\b[^`\n]*)`/g)) {
      codeSegments.push({ kind: "inline", text: match[1] });
    }
    for (const segment of codeSegments) {
      const commandText = segment.kind === "block"
        ? segment.text.split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^(?:[$>]\s*)?(?:npx\s+(?:@kungfu-tech\/buildchain|buildchain)\s+|node\s+bin\/buildchain\.mjs\s+|buildchain\s+)/.test(line))
            .join("\n")
        : segment.text;
      for (const match of commandText.matchAll(/(?:^|[\s$>])(?:npx\s+(?:@kungfu-tech\/buildchain|buildchain)\s+|node\s+bin\/buildchain\.mjs\s+|buildchain\s+)([a-z0-9][a-z0-9-]*|--help|--version|-h|-v)(?:\s+([a-z0-9][a-z0-9-]*|--[a-z0-9-]+))?/gm)) {
        const id = commandId(match[1], match[2]);
        if (segment.kind === "inline" && !knownCommandIds.has(id)) {
          continue;
        }
        refs.push({
          id,
          path: relPath,
          command: `buildchain ${match[1]}${match[2] ? ` ${match[2]}` : ""}`,
        });
      }
    }
  }
  return refs
    .filter((entry) => entry.id)
    .sort((a, b) => `${a.id}:${a.path}`.localeCompare(`${b.id}:${b.path}`));
}

function registryIds(entries) {
  return new Set((entries || []).map((entry) => entry.id).filter(Boolean));
}

export function collectPublicSurfaceReverseAudit({
  root = process.cwd(),
  cliRegistry: suppliedCliRegistry = undefined,
  workflowRegistry: suppliedWorkflowRegistry = undefined,
  pageRegistry: suppliedPageRegistry = undefined,
} = {}) {
  const cliCommands = enumerateCliCommandsFromBin({ root });
  const workflowInputs = enumerateWorkflowInputs({ root });
  const actionInputs = enumerateActionInputs({ root });
  const sitePages = suppliedPageRegistry
    ? (Array.isArray(suppliedPageRegistry?.pages) ? suppliedPageRegistry.pages : []).map((page) => ({
        id: page.id || page.path,
        path: page.path,
        category: page.category || "",
      })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    : enumerateSitePages({ root });
  const docCommandRefs = enumerateDocCommandRefs({ root });
  const cliRegistry = suppliedCliRegistry || readJson(root, "dist/site/cli-registry.json", { commands: [] });
  const workflowRegistry = suppliedWorkflowRegistry || readJson(root, "dist/site/workflow-registry.json", { workflows: [], actions: [] });
  const pageRegistry = suppliedPageRegistry || readJson(root, "dist/site/page-registry.json", { pages: [] });
  const declaredCli = registryIds(cliRegistry.commands);
  const declaredWorkflows = registryIds(workflowRegistry.workflows);
  const declaredActions = registryIds(workflowRegistry.actions);
  const declaredPages = registryIds(pageRegistry.pages);
  const missingCliRegistry = cliCommands.filter((entry) => !declaredCli.has(entry.id));
  const missingWorkflowRegistry = workflowInputs.filter((entry) => !declaredWorkflows.has(entry.id) && entry.inputCount > 0);
  const missingActionRegistry = actionInputs.filter((entry) => !declaredActions.has(entry.id) && entry.inputCount > 0);
  const missingPageRegistry = sitePages.filter((entry) => entry.id && !declaredPages.has(entry.id));
  const unknownDocCommandRefs = docCommandRefs.filter((entry) => !declaredCli.has(entry.id));
  const failures = [
    ...missingCliRegistry.map((entry) => `cli:${entry.id}`),
    ...missingWorkflowRegistry.map((entry) => `workflow:${entry.id}`),
    ...missingActionRegistry.map((entry) => `action:${entry.id}`),
    ...missingPageRegistry.map((entry) => `site:${entry.id}`),
    ...unknownDocCommandRefs.map((entry) => `doc-command:${entry.id}:${entry.path}`),
  ];
  const result = {
    schemaVersion: 1,
    contract: BUILDCHAIN_PUBLIC_SURFACE_AUDIT_CONTRACT,
    status: failures.length === 0 ? "passed" : "failed",
    summary: {
      cliCommandCount: cliCommands.length,
      workflowCount: workflowInputs.length,
      actionCount: actionInputs.length,
      sitePageCount: sitePages.length,
      docCommandRefCount: docCommandRefs.length,
      failureCount: failures.length,
    },
    enumerated: {
      cliCommands,
      workflowInputs,
      actionInputs,
      sitePages,
      docCommandRefs,
    },
    declared: {
      cliRegistryPath: "dist/site/cli-registry.json",
      workflowRegistryPath: "dist/site/workflow-registry.json",
      pageRegistryPath: "dist/site/page-registry.json",
      cliRegistryDigest: fs.existsSync(path.join(root, "dist/site/cli-registry.json")) ? sha256(readText(root, "dist/site/cli-registry.json")) : "",
      workflowRegistryDigest: fs.existsSync(path.join(root, "dist/site/workflow-registry.json")) ? sha256(readText(root, "dist/site/workflow-registry.json")) : "",
      pageRegistryDigest: fs.existsSync(path.join(root, "dist/site/page-registry.json")) ? sha256(readText(root, "dist/site/page-registry.json")) : "",
    },
    comparison: {
      missingCliRegistry,
      missingWorkflowRegistry,
      missingActionRegistry,
      missingPageRegistry,
      unknownDocCommandRefs,
    },
    auditBoundary: {
      mode: "closed-world-enumerable",
      scope: "Buildchain CLI usage/dispatch, reusable workflow inputs, action inputs, site pages, and documentation command references",
      residualRisk: [
        "Shell commands delegated through helper scripts are only counted when exposed through bin/buildchain.mjs usage or docs.",
        "YAML parsing is limited to first-class action/workflow inputs, not arbitrary step environment variables.",
      ],
    },
  };
  return result;
}

export function assertPublicSurfaceReverseAudit(report) {
  if (report.status !== "passed") {
    const failures = [
      ...report.comparison.missingCliRegistry.map((entry) => `missing CLI registry: ${entry.id}`),
      ...report.comparison.missingWorkflowRegistry.map((entry) => `missing workflow registry: ${entry.id}`),
      ...report.comparison.missingActionRegistry.map((entry) => `missing action registry: ${entry.id}`),
      ...report.comparison.missingPageRegistry.map((entry) => `missing site page registry: ${entry.id}`),
      ...report.comparison.unknownDocCommandRefs.map((entry) => `unknown docs command ref: ${entry.command} in ${entry.path}`),
    ];
    throw new Error(`Buildchain public surface reverse audit failed:\n${failures.join("\n")}`);
  }
  return report;
}
