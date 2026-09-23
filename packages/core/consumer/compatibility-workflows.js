import fs from "node:fs";
import path from "node:path";

export const CONSUMER_UPGRADE_PATH = "architecture/consumer-upgrade.json";

export function readConsumerUpgrade(root, files) {
  const source = files
    ? files[CONSUMER_UPGRADE_PATH]
    : fs.existsSync(path.join(root, CONSUMER_UPGRADE_PATH))
      ? fs.readFileSync(path.join(root, CONSUMER_UPGRADE_PATH), "utf8")
      : undefined;
  if (!source) return null;
  const contract = JSON.parse(source);
  if (
    contract.schema !== "buildchain.consumer-upgrade/v1" ||
    !/^[a-f0-9]{40}$/u.test(contract.source?.sha || "") ||
    !Array.isArray(contract.entries)
  )
    throw new Error("Invalid consumer upgrade contract");
  return contract;
}

export function compatibilityWorkflowTarget(root, relative, source) {
  const entry = readConsumerUpgrade(root)?.entries.find(
    (item) => item.path === relative,
  );
  if (!entry) return relative;
  const canonical = fs.readFileSync(path.join(root, entry.target), "utf8");
  if (source !== renderCompatibilityWorkflow(entry, canonical))
    throw new Error(
      `${relative}: generated consumer compatibility workflow drift`,
    );
  return entry.target;
}

// Keep the historical job names, outputs, permissions and publisher identity.
// A nested forwarding job would change required check contexts and OIDC identity.
// Business steps are always generated from the one maintained implementation.
export function renderCompatibilityWorkflow(entry, source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^on:\s*$/u.test(line));
  let end = start + 1;
  while (end < lines.length && !/^[a-z][a-z-]*:/u.test(lines[end])) end++;
  if (start < 0 || !entry.interfaceSource?.startsWith("on:\n"))
    throw new Error(
      `Consumer upgrade entry lacks its retained interface: ${entry.path}`,
    );
  lines.splice(start, end - start, entry.interfaceSource.trimEnd());
  return (
    "# Generated from the consumer upgrade contract; edit the canonical implementation.\n" +
    lines.join("\n")
  );
}

export function compatibilityWorkflowEntries(root, files, canonicalEntries) {
  const contract = readConsumerUpgrade(root, files);
  if (!contract) return [];
  const known = new Set(canonicalEntries.map((entry) => entry.path));
  const paths = new Set();
  return contract.entries.map((entry) => {
    if (
      !/^\.github\/workflows\/[.a-z0-9-]+\.yml$/u.test(entry.path) ||
      known.has(entry.path) ||
      paths.has(entry.path) ||
      !known.has(entry.target) ||
      entry.path === entry.target ||
      !entry.interface ||
      Object.keys(entry.interface).some(
        (key) => !["workflow_call", "workflow_dispatch"].includes(key),
      )
    )
      throw new Error(`Invalid consumer upgrade entry: ${entry.path}`);
    paths.add(entry.path);
    const target = canonicalEntries.find((item) => item.path === entry.target);
    return {
      ...target,
      ...entry,
      id: entry.path,
      role: "component",
      compatibility: true,
    };
  });
}
