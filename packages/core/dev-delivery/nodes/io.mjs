import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
export { writeGitHubOutputs as outputs } from "../../providers/commands/github-output.mjs";

export const evidenceDirectory = ".buildchain/dev-delivery";
export function readEvidence(name) {
  return JSON.parse(
    fs.readFileSync(path.join(evidenceDirectory, name), "utf8"),
  );
}
export function writeEvidence(name, value) {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const bytes = JSON.stringify(value, null, 2) + "\n";
  fs.writeFileSync(path.join(evidenceDirectory, name), bytes);
  return bytes;
}
export function runtimeCommand(name, args) {
  return command(process.execPath, [
    `.buildchain/runtime/packages/core/dev-delivery/commands/${name}.mjs`,
    ...args,
  ]);
}
