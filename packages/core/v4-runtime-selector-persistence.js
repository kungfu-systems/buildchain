import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const V4_RUNTIME_PERSISTENCE_SCAN_CONTRACT =
  "kungfu-buildchain-v4-runtime-persistence-scan/v1";

const EXACT_SHA = /^[0-9a-f]{40}$/u;
const TRAIN_V4_REF = /^train\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/u;
const AUTHORITY_V4_REF = /^authority\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/u;
const RUNTIME_SELECTOR =
  /(?:buildchain[-_. ]?(?:ref|runtime)|runtime[-_. ]?sha|resume[-_. ]?buildchain)/iu;
const EXACT_SHA_LITERAL = /\b[0-9a-f]{40}\b/giu;
const EXTERNAL_AUTHORITY = Object.freeze([
  ["oidc", /(?:id-token\s*:\s*write|oidc)/iu],
  ["iam", /(?:role-to-assume|aws[-_. ]?(?:role|iam)|\biam\b)/iu],
  ["repository-variable", /\$\{\{\s*vars\./u],
  ["secret", /\$\{\{\s*secrets\./u],
  ["environment", /\$\{\{\s*env\./u],
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function documentRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function normalizeRef(value) {
  return String(value || "")
    .trim()
    .replace(/^refs\/(?:heads|tags)\//u, "");
}

function transientSelector(value) {
  const normalized = normalizeRef(value);
  return (
    EXACT_SHA.test(normalized.toLowerCase()) ||
    TRAIN_V4_REF.test(normalized) ||
    AUTHORITY_V4_REF.test(normalized) ||
    /\$\{\{\s*(?:vars|secrets|env)\./u.test(value)
  );
}

function listFiles(rootPath, relative, output) {
  const directory = path.join(rootPath, relative);
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) listFiles(rootPath, child, output);
    else if (entry.isFile() && /\.(?:json|toml|ya?ml)$/u.test(entry.name)) {
      output.push(child.split(path.sep).join("/"));
    }
  }
}

function inputDefaultFailures(lines, sourcePath) {
  const failures = [];
  let current;
  for (const [index, line] of lines.entries()) {
    const key = line.match(/^(\s*)([a-z0-9-]+):\s*(?:#.*)?$/u);
    if (key) {
      const name = key[2];
      if (RUNTIME_SELECTOR.test(name))
        current = { indent: key[1].length, name };
      else if (current && key[1].length <= current.indent) current = undefined;
    }
    if (!current) continue;
    const defaultMatch = line.match(/^\s*default:\s*(.*?)\s*(?:#.*)?$/u);
    if (!defaultMatch) continue;
    const value = defaultMatch[1]
      .replace(/^(?:["'])(.*)(?:["'])$/u, "$1")
      .trim();
    if (transientSelector(value)) {
      failures.push({
        code: "persistent-runtime-default",
        path: sourcePath,
        line: index + 1,
        selector: current.name,
      });
    }
  }
  return failures;
}

function jsonSelectorFailures(value, sourcePath, trail = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      jsonSelectorFailures(entry, sourcePath, [...trail, index]),
    );
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const entryTrail = [...trail, key];
    const selected =
      (RUNTIME_SELECTOR.test(key) ||
        trail.some((part) => RUNTIME_SELECTOR.test(String(part)))) &&
      typeof entry === "string" &&
      transientSelector(entry)
        ? [
            {
              code: "persistent-runtime-json-value",
              path: sourcePath,
              jsonPointer: `/${entryTrail.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`,
            },
          ]
        : [];
    return [
      ...selected,
      ...jsonSelectorFailures(entry, sourcePath, entryTrail),
    ];
  });
}

function inspectSource({
  resolvedRoot,
  sourcePath,
  files,
  failures,
  authorityUsage,
}) {
  const file = path.resolve(resolvedRoot, sourcePath);
  if (!file.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(file)) {
    throw new Error(
      `runtime persistence scan path is missing or escapes root: ${sourcePath}`,
    );
  }
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/u);
  files.push({ path: sourcePath, digest: documentRoot(text) });
  failures.push(...inputDefaultFailures(lines, sourcePath));
  if (sourcePath.endsWith(".json")) {
    try {
      failures.push(...jsonSelectorFailures(JSON.parse(text), sourcePath));
    } catch (error) {
      failures.push({
        code: "runtime-selector-json-invalid",
        path: sourcePath,
        errorRoot: documentRoot(String(error?.message || error)),
      });
    }
  }
  for (const [index, line] of lines.entries()) {
    if (RUNTIME_SELECTOR.test(line)) {
      for (const match of line.matchAll(EXACT_SHA_LITERAL)) {
        failures.push({
          code: "persistent-runtime-exact-sha",
          path: sourcePath,
          line: index + 1,
          selectorRoot: documentRoot(match[0].toLowerCase()),
        });
      }
      if (/\$\{\{\s*(?:vars|secrets|env)\./u.test(line)) {
        failures.push({
          code: "persistent-runtime-external-indirection",
          path: sourcePath,
          line: index + 1,
        });
      }
    }
    for (const [authorityClass, pattern] of EXTERNAL_AUTHORITY) {
      if (pattern.test(line)) {
        authorityUsage.push({
          class: authorityClass,
          path: sourcePath,
          line: index + 1,
        });
      }
    }
  }
}

export function scanV4RuntimeSelectorPersistence({
  root: callerRoot = process.cwd(),
  paths = undefined,
} = {}) {
  const resolvedRoot = path.resolve(callerRoot);
  const sourcePaths = [];
  if (paths) sourcePaths.push(...paths);
  else {
    for (const relative of [
      ".github/workflows",
      ".github/actions",
      ".buildchain",
    ]) {
      listFiles(resolvedRoot, relative, sourcePaths);
    }
  }
  const excluded = new Set([
    ".buildchain/contract-lock.json",
    ".buildchain/alpha-contract-lock.json",
  ]);
  const files = [];
  const failures = [];
  const authorityUsage = [];
  for (const sourcePath of [...new Set(sourcePaths)].sort()) {
    if (!excluded.has(sourcePath)) {
      inspectSource({
        resolvedRoot,
        sourcePath,
        files,
        failures,
        authorityUsage,
      });
    }
  }
  const payload = {
    schemaVersion: 1,
    contract: V4_RUNTIME_PERSISTENCE_SCAN_CONTRACT,
    status: failures.length === 0 ? "passed" : "rejected",
    files,
    authorityUsage: authorityUsage.sort((left, right) =>
      stableJson(left).localeCompare(stableJson(right)),
    ),
    failures: failures.sort((left, right) =>
      stableJson(left).localeCompare(stableJson(right)),
    ),
  };
  return { ...payload, root: documentRoot(payload) };
}
