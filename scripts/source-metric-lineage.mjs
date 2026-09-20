import { execFileSync } from "node:child_process";

// Measurement identity follows Git's observed renames. This does not resolve a
// runtime path or keep a removed entrypoint callable.
export function projectRenamedMetrics({
  root,
  revision,
  metrics,
  currentPaths,
}) {
  const records = execFileSync(
    "git",
    [
      "diff",
      "--name-status",
      "-z",
      "--find-renames=50%",
      "--diff-filter=R",
      revision,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ).split("\0");
  const projected = { ...metrics },
    renames = [];
  for (let index = 0; index < records.length && records[index]; index += 3) {
    const [status, source, target] = records.slice(index, index + 3);
    if (!/^R\d+$/.test(status) || !source || !target)
      throw Error("Invalid Git metric lineage");
    if (!metrics[source] || metrics[target] || !currentPaths.has(target))
      continue;
    projected[target] = { ...metrics[source], file: target };
    renames.push({ source, target, similarity: Number(status.slice(1)) });
  }
  return { metrics: projected, renames };
}

// Workflow taxonomy IDs survive role/path changes and are available at both
// exact cuts even in a shallow checkout. Preserve their original measured budget.
export function projectWorkflowMetrics({
  metrics,
  before,
  after,
  currentPaths,
}) {
  for (const entries of [before, after])
    for (const key of ["id", "path"])
      if (
        new Set(entries.map((entry) => entry[key])).size !== entries.length ||
        entries.some((entry) => typeof entry[key] !== "string" || !entry[key])
      )
        throw Error(
          "Workflow measurement identities must be unique and explicit",
        );
  const originals = new Map(before.map((entry) => [entry.id, entry.path]));
  const projected = { ...metrics },
    renames = [];
  for (const { id, path: target } of after) {
    const source = originals.get(id);
    if (
      !source ||
      source === target ||
      !metrics[source] ||
      metrics[target] ||
      !currentPaths.has(target) ||
      currentPaths.has(source)
    )
      continue;
    projected[target] = { ...metrics[source], file: target };
    renames.push({ id, source, target });
  }
  return { metrics: projected, renames };
}
