import {
  BUILDCHAIN_COMMAND_REGISTRY,
  resolveBuildchainCommand,
} from "./command-registry.mjs";
import { commandId } from "./public-surface-cli.js";

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
