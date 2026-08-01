import fs from "node:fs";
import path from "node:path";

import {
  BUILDCHAIN_COMMAND_REGISTRY,
  resolveBuildchainCommand,
} from "../bin/internal/command-registry.mjs";
import { commandId } from "../packages/core/public-surface-cli.js";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeSpace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function usageSyntaxes(usageText) {
  const usage = String(usageText || "").split("\n\nExamples:", 1)[0];
  const syntaxes = [];
  let current = "";
  for (const line of usage.split(/\r?\n/)) {
    if (/^\s*buildchain\s+/.test(line)) {
      if (current) syntaxes.push(normalizeSpace(current));
      current = line.trim();
      continue;
    }
    if (current && /^\s{4,}\S/.test(line)) {
      current += ` ${line.trim()}`;
    }
  }
  if (current) syntaxes.push(normalizeSpace(current));
  return unique(syntaxes);
}

function expandPathToken(paths, token) {
  const alternatives = token.slice(1, -1).split("|");
  return paths.flatMap((entry) =>
    alternatives.map((value) => [...entry, value]),
  );
}

export function syntaxPaths(syntax) {
  const tokens = normalizeSpace(syntax).split(" ");
  if (tokens.shift() !== "buildchain") return [];
  let paths = [[]];
  for (const token of tokens) {
    if (!token || token === "..." || token.startsWith("[")) break;
    if (token.startsWith("--")) {
      if (token === "--dry-run" && paths[0].length === 1) {
        paths = paths.map((entry) => [...entry, token]);
      }
      break;
    }
    if (token.startsWith("<") && token.endsWith(">")) {
      if (token.includes("|")) {
        paths = expandPathToken(paths, token);
      }
      break;
    }
    if (/[\[<{]/.test(token)) break;
    paths = paths.map((entry) => [...entry, token]);
  }
  return paths.filter((entry) => entry.length > 0);
}

export function createCliReference(usageText) {
  const syntaxEntries = usageSyntaxes(usageText).map((syntax) => ({
    syntax,
    paths: syntaxPaths(syntax),
  }));
  const byPath = new Map();
  for (const entry of syntaxEntries) {
    for (const pathParts of entry.paths) {
      const key = pathParts.join(" ");
      const current = byPath.get(key) || { path: pathParts, syntaxes: [] };
      current.syntaxes.push(entry.syntax);
      byPath.set(key, current);
    }
  }
  for (const registration of BUILDCHAIN_COMMAND_REGISTRY) {
    if (!byPath.has(registration.id)) {
      byPath.set(registration.id, {
        path: [registration.id],
        syntaxes: [`buildchain ${registration.id}`],
      });
    }
  }
  return [...byPath.values()]
    .map((entry) => {
      const [head, second = "", third = ""] = entry.path;
      const registration = resolveBuildchainCommand(head);
      const canonicalHead = registration?.id || head;
      const canonicalPath = [canonicalHead, ...entry.path.slice(1)];
      const id = commandId(canonicalHead, second, third);
      return {
        id,
        path: canonicalPath,
        command: `buildchain ${canonicalPath.join(" ")}`,
        syntaxes: unique(entry.syntaxes).sort(),
        options: unique(
          entry.syntaxes.flatMap(
            (syntax) => syntax.match(/--[a-z0-9][a-z0-9-]*/gi) || [],
          ),
        ).sort(),
        aliases: canonicalPath.length === 1 ? registration?.aliases || [] : [],
        helpCommand: `buildchain ${canonicalPath.join(" ")} --help`,
      };
    })
    .sort((left, right) => left.command.localeCompare(right.command));
}

export function cliReferenceById(reference) {
  const grouped = new Map();
  for (const entry of reference) {
    const current = grouped.get(entry.id) || {
      paths: [],
      syntaxes: [],
      options: [],
      aliases: [],
      helpCommands: [],
    };
    current.paths.push(entry.path.join(" "));
    current.syntaxes.push(...entry.syntaxes);
    current.options.push(...entry.options);
    current.aliases.push(...entry.aliases);
    current.helpCommands.push(entry.helpCommand);
    grouped.set(entry.id, current);
  }
  return new Map(
    [...grouped].map(([id, entry]) => [
      id,
      {
        paths: unique(entry.paths).sort(),
        syntaxes: unique(entry.syntaxes).sort(),
        options: unique(entry.options).sort(),
        aliases: unique(entry.aliases).sort(),
        helpCommands: unique(entry.helpCommands).sort(),
      },
    ]),
  );
}

function canonicalHelpPath(pathParts) {
  if (pathParts.length === 0) return [];
  const registration = resolveBuildchainCommand(pathParts[0]);
  return [registration?.id || pathParts[0], ...pathParts.slice(1)];
}

export function formatCliHelp({ usageText, pathParts = [] } = {}) {
  const requested = canonicalHelpPath(
    pathParts.filter((entry) => entry && !["--help", "-h"].includes(entry)),
  );
  if (requested.length === 0) return String(usageText || "");
  const reference = createCliReference(usageText);
  const descendants = reference.filter((entry) =>
    requested.every((part, index) => entry.path[index] === part),
  );
  const exact = reference.find(
    (entry) => entry.path.join(" ") === requested.join(" "),
  );
  const family =
    descendants.length > 0
      ? descendants
      : reference.filter(
          (entry) => entry.path[0] === requested[0] && entry.path.length === 1,
        );
  if (family.length === 0) {
    throw new Error(`unsupported buildchain help path: ${requested.join(" ")}`);
  }
  const syntaxes = unique(family.flatMap((entry) => entry.syntaxes)).sort();
  const subcommands = unique(
    descendants.map((entry) => entry.path[requested.length]).filter(Boolean),
  ).sort();
  const lines = [
    `Buildchain help: ${requested.join(" ")}`,
    "",
    "Usage:",
    ...syntaxes.map((syntax) => `  ${syntax}`),
  ];
  if (subcommands.length > 0) {
    lines.push("", "Subcommands:", ...subcommands.map((entry) => `  ${entry}`));
  }
  if (exact?.aliases.length) {
    lines.push("", `Aliases: ${exact.aliases.join(", ")}`);
  }
  lines.push(
    "",
    "Help is read-only and exits without executing the command.",
    "",
  );
  return lines.join("\n");
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function splitTopLevel(value) {
  const entries = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (['"', "'", "`"].includes(character)) {
      quote = character;
      current += character;
      continue;
    }
    if (["(", "[", "{"].includes(character)) depth += 1;
    if ([")", "]", "}"].includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      entries.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

function matchingParen(source, start) {
  let depth = 0;
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (['"', "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parameterName(signature, index) {
  const value = signature
    .replace(/^\.\.\./, "")
    .split("=", 1)[0]
    .trim();
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return value;
  return `parameter${index + 1}`;
}

function functionDetails(source, start, name, asyncFunction) {
  const open = source.indexOf("(", start);
  const close = matchingParen(source, open);
  const parametersText = close === -1 ? "" : source.slice(open + 1, close);
  const parameters = splitTopLevel(parametersText).map((signature, index) => ({
    name: parameterName(signature, index),
    signature: normalizeSpace(signature),
  }));
  const signature = `${asyncFunction ? "async " : ""}function ${name}(${parameters.map((entry) => entry.signature).join(", ")})`;
  const nextExport = source.indexOf("\nexport ", Math.max(close, start) + 1);
  const body = source.slice(
    start,
    nextExport === -1 ? source.length : nextExport,
  );
  const effects = [];
  if (
    /\b(?:writeFile|appendFile|mkdir|rename|unlink|rm|copyFile|symlink)(?:Sync)?\s*\(/.test(
      body,
    )
  )
    effects.push("local-filesystem-write");
  if (
    /\b(?:spawn|spawnSync|exec|execFile|execFileSync|execSync)\s*\(/.test(body)
  )
    effects.push("subprocess");
  if (/\bfetch\s*\(|\bhttps?\./.test(body)) effects.push("network");
  if (
    effects.length === 0 &&
    /^(?:write|update|append|run|execute|report|apply|register|mark|record|transition|revoke|qualify|set|abort|rollback|start)/i.test(
      name,
    )
  ) {
    effects.push("may-write-or-invoke-external-actions");
  }
  return {
    signature,
    parameters,
    returns: asyncFunction ? "Promise<unknown>" : "unknown",
    errors: /\bthrow\b/.test(body)
      ? [
          "May throw an Error on rejected input or failed operations; follow the linked source contract.",
        ]
      : [
          "Errors from called operations may propagate; no narrower throw contract is declared in source.",
        ],
    sideEffects:
      effects.length > 0 ? effects : ["none-detected-by-static-source-scan"],
  };
}

function localDeclaration(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const functionMatch = new RegExp(
    `(?:export\\s+)?(async\\s+)?function\\s+${escaped}\\s*\\(`,
  ).exec(source);
  if (functionMatch) {
    return {
      name,
      kind: "function",
      line: lineNumber(source, functionMatch.index),
      start: functionMatch.index,
      ...functionDetails(
        source,
        functionMatch.index,
        name,
        Boolean(functionMatch[1]),
      ),
    };
  }
  const classMatch = new RegExp(`(?:export\\s+)?class\\s+${escaped}\\b`).exec(
    source,
  );
  if (classMatch) {
    return {
      name,
      kind: "class",
      line: lineNumber(source, classMatch.index),
      signature: `class ${name}`,
      parameters: [],
      returns: name,
      errors: [
        "Construction and method errors follow the linked source implementation.",
      ],
      sideEffects: ["class-dependent"],
    };
  }
  const valueMatch = new RegExp(
    `(?:export\\s+)?(const|let|var)\\s+${escaped}\\b`,
  ).exec(source);
  if (valueMatch) {
    return {
      name,
      kind: "constant",
      line: lineNumber(source, valueMatch.index),
      signature: `${valueMatch[1]} ${name}`,
      parameters: [],
      returns: "value",
      errors: ["Import does not declare a throw contract."],
      sideEffects: ["none-on-import"],
    };
  }
  return {
    name,
    kind: "value",
    line: 1,
    signature: name,
    parameters: [],
    returns: "unknown",
    errors: ["No narrower error contract was mechanically discoverable."],
    sideEffects: ["unknown"],
  };
}

function resolveModulePath(fromPath, specifier) {
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromPath), specifier),
  );
  return path.posix.extname(resolved) ? resolved : `${resolved}.js`;
}

function moduleExports({ root, relPath, cache, stack = [] }) {
  if (cache.has(relPath)) return cache.get(relPath);
  if (stack.includes(relPath))
    throw new Error(
      `cyclic public export chain: ${[...stack, relPath].join(" -> ")}`,
    );
  const source = fs.readFileSync(path.join(root, relPath), "utf8");
  const exports = new Map();
  const directPattern =
    /export\s+(async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(directPattern)) {
    const detail = localDeclaration(source, match[3]);
    exports.set(match[3], { ...detail, sourcePath: relPath });
  }
  const namedPattern =
    /export\s*\{([\s\S]*?)\}\s*(?:from\s*["']([^"']+)["'])?\s*;/g;
  for (const match of source.matchAll(namedPattern)) {
    const target = match[2] ? resolveModulePath(relPath, match[2]) : "";
    const targetExports = target
      ? moduleExports({
          root,
          relPath: target,
          cache,
          stack: [...stack, relPath],
        })
      : null;
    for (const item of splitTopLevel(match[1])) {
      const cleaned = item.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (!cleaned) continue;
      const [sourceName, exportedName = sourceName] = cleaned.split(/\s+as\s+/);
      const detail =
        targetExports?.get(sourceName) || localDeclaration(source, sourceName);
      exports.set(exportedName, {
        ...detail,
        name: exportedName,
        sourcePath: detail.sourcePath || relPath,
      });
    }
  }
  const starPattern = /export\s+\*\s+from\s+["']([^"']+)["']\s*;/g;
  for (const match of source.matchAll(starPattern)) {
    const target = resolveModulePath(relPath, match[1]);
    for (const [name, detail] of moduleExports({
      root,
      relPath: target,
      cache,
      stack: [...stack, relPath],
    })) {
      if (name !== "default") exports.set(name, detail);
    }
  }
  cache.set(relPath, exports);
  return exports;
}

export function createNodeApiReference({ root, packageJson }) {
  const cache = new Map();
  return Object.entries(packageJson.exports || {})
    .filter(
      ([specifier, target]) =>
        !specifier.startsWith("./site/") &&
        specifier !== "./package.json" &&
        typeof target === "string" &&
        target.endsWith(".js"),
    )
    .map(([exportName, target]) => {
      const relPath = target.replace(/^\.\//, "");
      const specifier =
        exportName === "."
          ? packageJson.name
          : `${packageJson.name}/${exportName.replace(/^\.\//, "")}`;
      const symbols = [...moduleExports({ root, relPath, cache })]
        .map(([name, detail]) => ({
          name,
          kind: detail.kind,
          signature: detail.signature,
          parameters: detail.parameters,
          returns: detail.returns,
          errors: detail.errors,
          sideEffects: detail.sideEffects,
          source: { path: detail.sourcePath, line: detail.line },
          example: `import { ${name} } from ${JSON.stringify(specifier)};`,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      return { export: exportName, specifier, target, symbols };
    });
}

const GENERATED_FRONTMATTER = `---
status: active
period: ongoing
theme: buildchain-generated-reference
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: generated
last_reviewed: 2026-08-01
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-01
  invisible_context: not asserted
---`;

export function renderCliReference(reference) {
  const lines = [
    GENERATED_FRONTMATTER,
    "",
    "# Buildchain CLI Reference",
    "",
    "> Generated from `BUILDCHAIN_USAGE` and the runtime command registry. Do not edit this file by hand.",
    "",
    "Every listed help command is intercepted before dispatch, exits zero, and performs no command side effects.",
  ];
  let currentHead = "";
  for (const entry of reference) {
    if (entry.path[0] !== currentHead) {
      currentHead = entry.path[0];
      lines.push("", `## \`${currentHead}\``);
    }
    lines.push(
      "",
      `### \`${entry.command}\``,
      "",
      `- Help: \`${entry.helpCommand}\``,
      `- Canonical id: \`${entry.id}\``,
      `- Options: ${entry.options.length ? entry.options.map((option) => `\`${option}\``).join(", ") : "none declared"}`,
      "- Syntax:",
      "",
      "```text",
      ...entry.syntaxes,
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

function markdownCell(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ");
}

export function renderNodeApiReference(reference) {
  const lines = [
    GENERATED_FRONTMATTER,
    "",
    "# Buildchain Node API Reference",
    "",
    "> Generated from `package.json#exports` and the exported ESM symbols in each target. Do not edit this file by hand.",
    "",
    "Signatures and source locations are mechanical. JavaScript return types remain conservative where the source declares no static type.",
  ];
  for (const surface of reference) {
    lines.push(
      "",
      `## \`${surface.specifier}\``,
      "",
      `Target: \`${surface.target}\`. Public symbols: ${surface.symbols.length}.`,
      "",
      "| Symbol | Kind and signature | Parameters | Return | Errors | Side effects | Example | Source |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const symbol of surface.symbols) {
      const parameters = symbol.parameters.length
        ? symbol.parameters.map((entry) => entry.signature).join(", ")
        : "none";
      lines.push(
        `| \`${symbol.name}\` | ${markdownCell(`${symbol.kind}: ${symbol.signature}`)} | ${markdownCell(parameters)} | ${markdownCell(symbol.returns)} | ${markdownCell(symbol.errors.join(" "))} | ${markdownCell(symbol.sideEffects.join(", "))} | \`${markdownCell(symbol.example)}\` | \`${symbol.source.path}:${symbol.source.line}\` |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
