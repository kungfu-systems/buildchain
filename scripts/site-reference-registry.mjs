import { createNodeApiReference } from "./public-reference.mjs";

export function createSiteNodeApiRegistry({
  root,
  packageJson,
  nodeApiMeta,
  sha256File,
  publicSurfaceLifecycle,
}) {
  const reference = createNodeApiReference({ root, packageJson });
  const referenceByExport = new Map(
    reference.map((entry) => [entry.export, entry]),
  );
  const symbolsById = new Map();
  for (const surface of reference) {
    const meta = nodeApiMeta(surface.export);
    for (const symbol of surface.symbols) {
      const id = `${symbol.source.path}#${symbol.name}`;
      if (!symbolsById.has(id)) {
        symbolsById.set(id, {
          id,
          ...symbol,
          maturity: meta.maturity,
          audience: meta.audience,
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-node-api-registry",
    package: packageJson.name,
    moduleSystem: packageJson.type || "module",
    symbols: [...symbolsById.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    exports: Object.entries(packageJson.exports || {})
      .filter(
        ([specifier]) =>
          !specifier.startsWith("./site/") && specifier !== "./package.json",
      )
      .map(([specifier, target]) => {
        const meta = nodeApiMeta(specifier);
        const surface = referenceByExport.get(specifier);
        return {
          specifier:
            specifier === "."
              ? packageJson.name
              : `${packageJson.name}/${specifier.replace(/^\.\//, "")}`,
          export: specifier,
          target,
          digest:
            typeof target === "string"
              ? sha256File(target.replace(/^\.\//, ""))
              : "",
          summary: meta.summary,
          capabilityGroup: meta.capabilityGroup,
          audience: meta.audience,
          symbolCount: surface?.symbols.length || 0,
          symbolIds: (surface?.symbols || []).map(
            (symbol) => `${symbol.source.path}#${symbol.name}`,
          ),
          ...publicSurfaceLifecycle({
            owner: "buildchain-core",
            maturity: meta.maturity,
            nonDuplicationRationale:
              "Existing package subpath retained as the canonical API boundary for this capability.",
          }),
        };
      }),
    docs: [
      ["cli-and-node-package", "docs/cli.md"],
      ["node-api-reference", "docs/node-api-reference.md"],
      ["build-facts", "docs/build-facts.md"],
      ["kfd-support", "docs/kfd-support.md"],
      ["readme-badges", "docs/readme-badges.md"],
      ["homebrew", "docs/homebrew.md"],
      ["site-bundle-contract", "docs/site-bundle-contract.md"],
    ].map(([id, docPath]) => ({
      id,
      path: docPath,
      digest: sha256File(docPath),
    })),
    guidance:
      "These are the public Node import surfaces and symbols shipped by the npm package. Prefer them over internal file paths.",
  };
}

function assertCliReferenceRegistry(cliRegistry) {
  for (const command of cliRegistry.commands || []) {
    for (const field of [
      "paths",
      "syntaxes",
      "options",
      "aliases",
      "helpCommands",
    ]) {
      if (!Array.isArray(command[field])) {
        throw new Error(
          `cli-registry.json command missing generated ${field}: ${command.id || command.usage}`,
        );
      }
    }
    if (
      command.paths.length === 0 ||
      command.syntaxes.length === 0 ||
      command.helpCommands.length === 0
    ) {
      throw new Error(
        `cli-registry.json command has an empty generated reference: ${command.id || command.usage}`,
      );
    }
  }
}

function assertNodeSymbol(symbol) {
  const arraysComplete =
    Array.isArray(symbol.parameters) &&
    Array.isArray(symbol.errors) &&
    symbol.errors.length > 0 &&
    Array.isArray(symbol.sideEffects) &&
    symbol.sideEffects.length > 0 &&
    Array.isArray(symbol.audience);
  const sourceComplete =
    symbol.source?.path && Number.isInteger(symbol.source?.line);
  if (
    !symbol.id ||
    !symbol.name ||
    !symbol.kind ||
    !symbol.signature ||
    !symbol.returns ||
    !symbol.maturity ||
    !symbol.example ||
    !arraysComplete ||
    !sourceComplete
  ) {
    throw new Error(
      `node-api-registry.json symbol is incomplete: ${symbol.id || "<unknown>"}`,
    );
  }
}

function assertNodeReferenceRegistry(nodeApiRegistry) {
  const symbolsById = new Map(
    (nodeApiRegistry.symbols || []).map((symbol) => [symbol.id, symbol]),
  );
  for (const symbol of symbolsById.values()) assertNodeSymbol(symbol);
  for (const surface of nodeApiRegistry.exports || []) {
    if (
      !Number.isInteger(surface.symbolCount) ||
      surface.symbolCount !== surface.symbolIds?.length ||
      surface.symbolCount === 0
    ) {
      throw new Error(
        `node-api-registry.json export has incomplete symbol closure: ${surface.export || surface.specifier}`,
      );
    }
    for (const id of surface.symbolIds) {
      if (!symbolsById.has(id)) {
        throw new Error(
          `node-api-registry.json export references an unknown symbol: ${surface.specifier}#${id}`,
        );
      }
    }
  }
}

export function assertPublicReferenceRegistry({
  cliRegistry,
  nodeApiRegistry,
}) {
  assertCliReferenceRegistry(cliRegistry);
  assertNodeReferenceRegistry(nodeApiRegistry);
}
