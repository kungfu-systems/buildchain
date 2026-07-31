import { collectPaperPreflight } from "../packages/core/paper.js";

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1] || "";
}

export function runPaperAgentCli({
  command,
  subcommand,
  args,
  cwd,
  buildchainRoot,
  buildchainVersion,
  buildchainRef,
  buildchainSha,
}) {
  if (command !== "agent" || subcommand !== "verify") {
    return { handled: false, result: null };
  }
  return {
    handled: true,
    result: collectPaperPreflight({
      cwd,
      buildchainRoot,
      buildchainVersion,
      buildchainRef: readFlag(args, "buildchain-ref", buildchainRef),
      buildchainSha,
      registry: readFlag(args, "registry", "https://registry.npmjs.org/"),
      offline: args.includes("--offline"),
      agentEntryMode: "local",
    }),
  };
}
