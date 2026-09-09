import fs from "node:fs";
import path from "node:path";

function normalizeSpace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
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
