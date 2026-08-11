#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const implementationExtensions = new Set([".js", ".mjs", ".cjs", ".sh"]);
const importPattern =
  /(?:\bimport\s*(?:\([^)]*?\)|[^"'\n]*?\s+from\s+)?|\bexport\s+[^"'\n]*?\s+from\s+)(["'])([^"'\n]+)\1/g;

function normalizeRelative(root, value) {
  return path
    .relative(root, path.resolve(root, value))
    .split(path.sep)
    .join("/");
}

function isInside(relativePath, prefix) {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function collectImplementationFiles(root, entry) {
  const absolute = path.resolve(root, entry);
  if (!fs.existsSync(absolute)) {
    throw new Error(`internal architecture path is missing: ${entry}`);
  }
  if (fs.statSync(absolute).isFile()) {
    return implementationExtensions.has(path.extname(absolute))
      ? [absolute]
      : [];
  }
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((item) =>
      collectImplementationFiles(root, path.join(entry, item.name)),
    );
}

function relativeImports(source) {
  const imports = [];
  for (const match of source.matchAll(importPattern)) {
    if (match[2].startsWith(".")) imports.push(match[2]);
  }
  return imports;
}

function resolveImportTarget(root, sourcePath, specifier) {
  const absolute = path.resolve(
    path.dirname(path.resolve(root, sourcePath)),
    specifier,
  );
  return normalizeRelative(root, absolute);
}

function resolveGraphTarget(root, sourcePath, specifier, implementationPaths) {
  const target = resolveImportTarget(root, sourcePath, specifier);
  return [
    target,
    `${target}.js`,
    `${target}.mjs`,
    `${target}.cjs`,
    `${target}/index.js`,
    `${target}/index.mjs`,
  ].find((candidate) => implementationPaths.has(candidate));
}

function dependencyCycles(graph) {
  const cycles = [];
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const canonical = new Set();
  const visit = (node) => {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const members = cycle.slice(0, -1);
      const rotations = members.map((_, index) =>
        [...members.slice(index), ...members.slice(0, index)].join(" -> "),
      );
      const key = rotations.sort()[0];
      if (!canonical.has(key)) {
        canonical.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const target of graph.get(node) || []) visit(target);
    stack.pop();
    active.delete(node);
  };
  for (const node of [...graph.keys()].sort()) visit(node);
  return cycles;
}

function assertIndexShape(index) {
  if (index?.schemaVersion !== 1) {
    throw new Error("internal architecture index schemaVersion must be 1");
  }
  for (const field of [
    "coverageRoots",
    "dependencyRules",
    "ownershipRules",
    "capabilities",
  ]) {
    if (!Array.isArray(index[field]) || index[field].length === 0) {
      throw new Error(
        `internal architecture index requires non-empty ${field}`,
      );
    }
  }
}

function repositoryJavaScriptFiles(root) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.resolve(root, file)))
    .filter((file) => [".js", ".mjs", ".cjs"].includes(path.extname(file)))
    .filter((file) => !file.startsWith("tests/"))
    .filter((file) => !/(?:^|\/)tests?\//u.test(file))
    .filter((file) => !file.startsWith(".buildchain/"))
    .filter((file) => !/^actions\/[^/]+\/dist\//u.test(file))
    .sort();
}

function ownershipFor(index, sourcePath) {
  return index.ownershipRules.filter((rule) =>
    (rule.paths || []).some((prefix) => isInside(sourcePath, prefix)),
  );
}

function evaluateSourceOwnership(index, repositorySources) {
  const issues = [];
  const exclusions = new Map(
    (index.ownershipExclusions || []).map((entry) => [entry.path, entry]),
  );
  let ownedSources = 0;
  let excludedSources = 0;
  for (const sourcePath of repositorySources) {
    const owners = ownershipFor(index, sourcePath);
    const exclusion = exclusions.get(sourcePath);
    if (owners.length === 1 && !exclusion) {
      if (!String(owners[0].owner || "").trim()) {
        issues.push(`${owners[0].id}: ownership rule owner is empty`);
      } else {
        ownedSources += 1;
      }
    } else if (owners.length === 0 && exclusion) {
      if (!String(exclusion.rationale || "").trim()) {
        issues.push(`${sourcePath}: ownership exclusion requires a rationale`);
      } else {
        excludedSources += 1;
      }
    } else if (owners.length === 0) {
      issues.push(`repository source has no owner: ${sourcePath}`);
    } else if (owners.length > 1) {
      issues.push(
        `repository source has multiple owners: ${sourcePath} (${owners.map((entry) => entry.id).join(", ")})`,
      );
    } else {
      issues.push(
        `repository source is both owned and excluded: ${sourcePath}`,
      );
    }
  }
  for (const [sourcePath] of exclusions) {
    if (!repositorySources.includes(sourcePath)) {
      issues.push(`ownership exclusion is stale: ${sourcePath}`);
    }
  }
  return { issues, ownedSources, excludedSources };
}

function evaluateCapabilities(root, index) {
  const issues = [];
  const capabilityIds = new Set();
  const coveredImplementation = new Map();
  for (const capability of index.capabilities) {
    if (!capability?.id || capabilityIds.has(capability.id)) {
      issues.push(
        `capability id must be present and unique: ${capability?.id || "<empty>"}`,
      );
      continue;
    }
    capabilityIds.add(capability.id);
    if (!capability.owner || typeof capability.owner !== "string") {
      issues.push(`${capability.id}: owner is empty`);
    }
    if (
      !Array.isArray(capability.implementation) ||
      capability.implementation.length === 0
    ) {
      issues.push(`${capability.id}: implementation mapping is empty`);
    }
    if (!Array.isArray(capability.tests) || capability.tests.length === 0) {
      issues.push(`${capability.id}: test mapping is empty`);
    }
    for (const field of ["implementation", "tests", "contracts"]) {
      for (const relativePath of capability[field] || []) {
        if (!fs.existsSync(path.resolve(root, relativePath))) {
          issues.push(
            `${capability.id}: ${field} path is missing: ${relativePath}`,
          );
        }
        if (field !== "implementation") continue;
        const owner = coveredImplementation.get(relativePath);
        if (owner) {
          issues.push(
            `${relativePath}: implementation is mapped by both ${owner} and ${capability.id}`,
          );
        } else {
          coveredImplementation.set(relativePath, capability.id);
        }
      }
    }
  }
  const expectedImplementation = new Set(
    index.coverageRoots.flatMap((entry) =>
      collectImplementationFiles(root, entry).map((absolutePath) =>
        normalizeRelative(root, absolutePath),
      ),
    ),
  );
  for (const relativePath of expectedImplementation) {
    if (!coveredImplementation.has(relativePath)) {
      issues.push(
        `capability-to-test mapping is missing implementation: ${relativePath}`,
      );
    }
  }
  for (const relativePath of coveredImplementation.keys()) {
    if (!expectedImplementation.has(relativePath)) {
      issues.push(
        `capability implementation is outside coverageRoots: ${relativePath}`,
      );
    }
  }
  return { issues, expectedImplementation };
}

function evaluateDependencyDirections(root, index, sourceOverrides) {
  const issues = [];
  for (const rule of index.dependencyRules) {
    const allowed = rule.allowedRelativeTargets || [];
    for (const sourceEntry of rule.sources || []) {
      for (const absoluteSource of collectImplementationFiles(
        root,
        sourceEntry,
      )) {
        if (![".js", ".mjs", ".cjs"].includes(path.extname(absoluteSource)))
          continue;
        const sourcePath = normalizeRelative(root, absoluteSource);
        const source = sourceOverrides.has(sourcePath)
          ? sourceOverrides.get(sourcePath)
          : fs.readFileSync(absoluteSource, "utf8");
        for (const specifier of relativeImports(source)) {
          const target = resolveImportTarget(root, sourcePath, specifier);
          if (!allowed.some((prefix) => isInside(target, prefix))) {
            issues.push(
              `${rule.id}: ${sourcePath} imports ${target}, outside allowed dependency direction`,
            );
          }
        }
      }
    }
  }
  return issues;
}

function buildRepositoryGraph(root, repositorySources, sourceOverrides) {
  const sourceSet = new Set(repositorySources);
  const graph = new Map(repositorySources.map((file) => [file, new Set()]));
  for (const sourcePath of repositorySources) {
    const source = sourceOverrides.has(sourcePath)
      ? sourceOverrides.get(sourcePath)
      : fs.readFileSync(path.resolve(root, sourcePath), "utf8");
    for (const specifier of relativeImports(source)) {
      const target = resolveGraphTarget(root, sourcePath, specifier, sourceSet);
      if (target) graph.get(sourcePath).add(target);
    }
  }
  return graph;
}

function checkInternalArchitecture({
  root = process.cwd(),
  index = JSON.parse(
    fs.readFileSync(
      path.join(root, "architecture", "internal-capabilities.json"),
      "utf8",
    ),
  ),
  sourceOverrides = new Map(),
} = {}) {
  assertIndexShape(index);
  const issues = [];
  const repositorySources = repositoryJavaScriptFiles(root);
  const ownership = evaluateSourceOwnership(index, repositorySources);
  const capabilities = evaluateCapabilities(root, index);
  issues.push(...ownership.issues, ...capabilities.issues);
  issues.push(...evaluateDependencyDirections(root, index, sourceOverrides));
  const graph = buildRepositoryGraph(root, repositorySources, sourceOverrides);
  const cycles = dependencyCycles(graph);
  for (const cycle of cycles) {
    issues.push(`internal dependency cycle: ${cycle.join(" -> ")}`);
  }

  if (issues.length > 0) {
    throw new Error(
      `internal architecture check failed:\n- ${issues.join("\n- ")}`,
    );
  }
  return {
    schemaVersion: index.schemaVersion,
    capabilities: index.capabilities.length,
    implementations: capabilities.expectedImplementation.size,
    repositorySources: repositorySources.length,
    ownedSources: ownership.ownedSources,
    excludedSources: ownership.excludedSources,
    dependencyEdges: [...graph.values()].reduce(
      (total, targets) => total + targets.size,
      0,
    ),
    dependencyRules: index.dependencyRules.length,
    dependencyCycles: cycles.length,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const report = checkInternalArchitecture();
    console.log(
      `internal architecture check passed: ${report.capabilities} capabilities, ` +
        `${report.implementations} capability implementations, ${report.ownedSources}/${report.repositorySources} owned sources, ` +
        `${report.dependencyEdges} dependency edges, ${report.dependencyRules} dependency rules, ` +
        `${report.dependencyCycles} cycles`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export {
  checkInternalArchitecture,
  dependencyCycles,
  relativeImports,
  repositoryJavaScriptFiles,
};
