const BUILDCHAIN_COMMAND_REGISTRY = Object.freeze([
  { id: "help", aliases: ["-h", "--help"] },
  { id: "version", aliases: ["-v", "--version"] },
  { id: "layout", aliases: [] },
  { id: "portable-cache", aliases: [] },
  { id: "candidate", aliases: [] },
  { id: "init", aliases: [] },
  { id: "validate", aliases: [] },
  { id: "doctor", aliases: [] },
  { id: "dev", aliases: [] },
  { id: "log", aliases: [] },
  { id: "diagnostics", aliases: [] },
  { id: "facts", aliases: [] },
  { id: "kfd", aliases: [] },
  { id: "sample", aliases: [] },
  { id: "mark", aliases: [] },
  { id: "span", aliases: [] },
  { id: "lifecycle", aliases: [] },
  { id: "npm", aliases: [] },
  { id: "audit", aliases: [] },
  { id: "collect", aliases: [] },
  { id: "create", aliases: [] },
  { id: "explain", aliases: [] },
  { id: "inspect", aliases: [] },
  { id: "project", aliases: [] },
  { id: "release", aliases: [] },
  { id: "transaction", aliases: [] },
  { id: "verify", aliases: [] },
  { id: "web-surface", aliases: [] },
  { id: "infra-contract", aliases: [] },
  { id: "publication-artifact", aliases: ["publication"] },
  { id: "paper", aliases: [] },
  { id: "release-propagation", aliases: [] },
  { id: "release-governance", aliases: [] },
  { id: "release-tail", aliases: [] },
  { id: "github-governance", aliases: [] },
  { id: "badges", aliases: [] },
  { id: "homebrew", aliases: [] },
  { id: "build-contract", aliases: [] },
  { id: "publish-source", aliases: [] },
  { id: "architecture", aliases: [] },
]);

function buildCommandLookup(registry = BUILDCHAIN_COMMAND_REGISTRY) {
  const lookup = new Map();
  for (const entry of registry) {
    for (const name of [entry.id, ...entry.aliases]) {
      if (lookup.has(name)) {
        throw new Error(
          `duplicate Buildchain CLI command registration: ${name}`,
        );
      }
      lookup.set(name, entry);
    }
  }
  return lookup;
}

const BUILDCHAIN_COMMAND_LOOKUP = buildCommandLookup();

function resolveBuildchainCommand(command) {
  return BUILDCHAIN_COMMAND_LOOKUP.get(command || "help");
}

async function dispatchRegisteredCommand({ command, args = [], handlers }) {
  const registration = resolveBuildchainCommand(command);
  if (!registration) {
    throw new Error(`unsupported buildchain command: ${command}`);
  }
  const handler = handlers?.[registration.id];
  if (typeof handler !== "function") {
    throw new Error(
      `Buildchain CLI command has no registered handler: ${registration.id}`,
    );
  }
  return handler(args, { command, registration });
}

export {
  BUILDCHAIN_COMMAND_REGISTRY,
  buildCommandLookup,
  dispatchRegisteredCommand,
  resolveBuildchainCommand,
};
