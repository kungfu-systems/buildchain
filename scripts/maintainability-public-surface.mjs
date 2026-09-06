import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isGeneratedFacadePublicTransition,
  loadUniversalFacadeMigration,
} from "./universal-facade-maintainability.mjs";

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function readJsonAtRevision(root, revision, file) {
  return JSON.parse(
    execFileSync("git", ["show", `${revision}:${file}`], {
      cwd: root,
      encoding: "utf8",
    }),
  );
}

function publicSurfaceContract(entry, kind) {
  if (kind === "cli") return { id: entry.id, usage: entry.usage };
  if (kind === "node")
    return {
      export: entry.export,
      specifier: entry.specifier,
      target: entry.target,
    };
  return {
    id: entry.id,
    path: entry.path,
    reusable: entry.reusable,
    inputs: entry.inputs || [],
    secrets: entry.secrets || [],
    outputs: entry.outputs || [],
  };
}

function evaluatePublicSurface({
  root,
  revision,
  policy,
  migration = loadUniversalFacadeMigration(root),
}) {
  const issues = [];
  const capabilityGroups = new Set(
    readJson(root, "dist/site/capability-registry.json").groups.map(
      (entry) => entry.id,
    ),
  );
  const definitions = [
    ["dist/site/cli-registry.json", "commands", "cli", "id"],
    ["dist/site/node-api-registry.json", "exports", "node", "export"],
    ["dist/site/workflow-registry.json", "workflows", "workflow", "id"],
    ["dist/site/workflow-registry.json", "actions", "action", "id"],
  ];
  for (const [file, collection, kind, key] of definitions) {
    const current = readJson(root, file)[collection] || [];
    const baseline = readJsonAtRevision(root, revision, file)[collection] || [];
    const previousByKey = new Map(baseline.map((entry) => [entry[key], entry]));
    for (const entry of current) {
      const label = `${kind}:${entry[key]}`;
      for (const field of policy.publicSurfacePolicy.requiredLifecycleFields) {
        if (
          !Object.prototype.hasOwnProperty.call(entry, field) ||
          typeof entry[field] !== "string"
        )
          issues.push(`${label}: lifecycle field ${field} is missing`);
      }
      if (!capabilityGroups.has(entry.capabilityGroup))
        issues.push(
          `${label}: capability group ${entry.capabilityGroup || "<empty>"} is not registered`,
        );
      const previous = previousByKey.get(entry[key]);
      const currentContract = publicSurfaceContract(entry, kind);
      if (
        previous &&
        JSON.stringify(currentContract) !==
          JSON.stringify(publicSurfaceContract(previous, kind))
      ) {
        const approval = policy.approvedPublicSurfaceTransitions?.[label];
        const approvedContract =
          approval?.fromRevision === revision &&
          String(approval?.rationale || "").trim()
            ? approval.contract
            : null;
        const generated = isGeneratedFacadePublicTransition({
          entry,
          kind,
          migration,
          baseContract:
            approvedContract || publicSurfaceContract(previous, kind),
          currentContract,
        });
        if (
          !generated &&
          (!approvedContract ||
            JSON.stringify(approvedContract) !==
              JSON.stringify(currentContract))
        )
          issues.push(
            `${label}: existing public contract drifted from ${revision}`,
          );
      }
      if (!previous && !entry.nonDuplicationRationale)
        issues.push(
          `${label}: new public surface requires a non-duplication rationale`,
        );
    }
  }
  return issues;
}

export { evaluatePublicSurface, publicSurfaceContract };
