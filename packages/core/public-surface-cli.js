import fs from "node:fs";
import path from "node:path";

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function listFiles(root, dir, predicate = () => true) {
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function releaseCommandId(sub) {
  if (["--dry-run", "dry-run", "explain"].includes(sub))
    return "release-dry-run";
  if (sub === "line") return "release-line-open";
  return "release-transaction";
}

function kfdCommandId(sub, leaf) {
  if (!sub || sub === "...") return "kfd";
  if (["schema", "upstream"].includes(sub) || /^[1-9][0-9]*$/.test(sub)) {
    return leaf ? `kfd-${sub}-${leaf}` : `kfd-${sub}`;
  }
  return `kfd-${sub}`;
}

function paperCommandId(sub, leaf) {
  if (sub === "bootstrap" && leaf === "npm") return "paper-bootstrap-npm";
  if (["work", "fleet"].includes(sub) && leaf) return `paper-${sub}-${leaf}`;
  return sub ? `paper-${sub}` : "paper";
}

export function commandId(first = "", second = "", third = "") {
  const head = String(first || "").trim();
  const sub = String(second || "").trim();
  const leaf =
    String(third || "").trim() === "..." ? "" : String(third || "").trim();
  const paired = new Set([
    "collect",
    "verify",
    "explain",
    "inspect",
    "npm",
    "diagnostics",
    "sample",
    "badges",
    "homebrew",
  ]);
  if (!head) return "";
  if (["-h", "--help", "help"].includes(head)) return "help";
  if (["-v", "--version", "version"].includes(head)) return "version";
  if (head === "release") return releaseCommandId(sub);
  if (head === "transaction") return "transaction-inspect";
  if (paired.has(head) && sub) return `${head}-${sub}`;
  if (head === "lifecycle" && sub) return "lifecycle";
  if (head === "log" && sub) return "logging";
  if (head === "facts" && sub) return "build-facts";
  if (head === "kfd") return kfdCommandId(sub, leaf);
  if (["release-propagation", "publish-source"].includes(head)) return head;
  if (["publication-artifact", "publication"].includes(head)) {
    return sub ? `publication-artifact-${sub}` : "publication-artifact";
  }
  if (head === "paper") return paperCommandId(sub, leaf);
  return head;
}

function usageCommands(source) {
  const usageMatch = source.match(/`Usage:\n([\s\S]*?)`;/);
  const rows = [];
  for (const line of (usageMatch?.[1] || "").split(/\r?\n/)) {
    const match = line
      .trim()
      .match(/^buildchain\s+([^\s]+)(?:\s+([^\s]+))?(?:\s+([^\s]+))?/);
    if (!match) continue;
    rows.push({
      id: commandId(match[1], match[2], match[3]),
      usage: line.trim().replace(/\s+/g, " "),
    });
  }
  return rows;
}

export function enumerateCliCommandsFromBin({
  root = process.cwd(),
  binPath = "bin/buildchain.mjs",
} = {}) {
  const binSource = readText(root, binPath);
  const helpSource = readText(root, "scripts/buildchain-cli-help.mjs");
  const registrySource = readText(
    root,
    "bin/internal/command-registry.mjs",
  );
  const dispatchSource = [
    binSource,
    ...listFiles(root, "bin/internal", (name) => name.endsWith(".mjs")).map(
      (relPath) => readText(root, relPath),
    ),
  ].join("\n");
  const usage = usageCommands(helpSource);
  const dispatch = [
    ...dispatchSource.matchAll(/if\s*\(\s*command\s*===\s*"([^"]+)"/g),
  ].map((match) => commandId(match[1]));
  const registered = [
    ...registrySource.matchAll(/\{\s*id:\s*"([^"]+)"/g),
  ].map((match) => commandId(match[1]));
  return uniqueSorted([
    ...usage.map((entry) => entry.id),
    ...dispatch,
    ...registered,
  ]).map(
    (id) => ({
      id,
      source: "bin/buildchain.mjs",
      usage:
        usage.find((entry) => entry.id === id)?.usage || `buildchain ${id}`,
    }),
  );
}
