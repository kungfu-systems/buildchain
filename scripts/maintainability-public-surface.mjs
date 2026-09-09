import fs from "node:fs";
import path from "node:path";

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

// Public API ownership follows the current architecture. Retired release
// contracts do not require aliases or forwarding implementations in 4.1.
export function evaluatePublicSurface({ root, policy }) {
  const issues = [];
  const groups = new Set(readJson(root, "dist/site/capability-registry.json").groups.map(entry => entry.id));
  for (const [file, collection, kind, key] of [
    ["dist/site/cli-registry.json", "commands", "cli", "id"],
    ["dist/site/node-api-registry.json", "exports", "node", "export"],
    ["dist/site/workflow-registry.json", "workflows", "workflow", "id"],
    ["dist/site/workflow-registry.json", "actions", "action", "id"],
  ]) {
    const identities = new Set();
    for (const entry of readJson(root, file)[collection] || []) {
      const label = `${kind}:${entry[key]}`;
      if (!entry[key] || identities.has(entry[key])) issues.push(`${label}: missing or duplicate public identity`);
      identities.add(entry[key]);
      for (const field of policy.publicSurfacePolicy.requiredLifecycleFields) {
        if (!Object.hasOwn(entry, field) || typeof entry[field] !== "string") issues.push(`${label}: lifecycle field ${field} is missing`);
      }
      if (!groups.has(entry.capabilityGroup)) issues.push(`${label}: capability group ${entry.capabilityGroup || "<empty>"} is not registered`);
      if (!entry.nonDuplicationRationale?.trim()) issues.push(`${label}: public surface requires a non-duplication rationale`);
      if (entry.compatibilityPromise !== "current-contract-only") issues.push(`${label}: historical compatibility promise is not part of the current architecture`);
      if (kind === "action" && !["public", "implementation"].includes(entry.apiRole)) issues.push(`${label}: action API role is missing`);
      const target = kind === "node" ? entry.target : ["workflow", "action"].includes(kind) ? entry.path : null;
      if (target) {
        const resolved = path.resolve(root, target);
        if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(resolved)) issues.push(`${label}: implementation target is missing or outside the repository`);
      }
    }
  }
  return issues;
}
