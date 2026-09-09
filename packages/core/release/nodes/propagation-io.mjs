import fs from "node:fs";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";

export function propagationPaths(env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  return {
    workspace,
    root: path.join(workspace, ".buildchain/release-propagation"),
    runtime: path.join(workspace, ".buildchain/runtime"),
    downstream: path.join(workspace, "downstream"),
  };
}
export const request = (env) =>
  JSON.parse(env.BUILDCHAIN_PROPAGATION_REQUEST_JSON);
export function readPropagation(name, env) {
  return JSON.parse(
    fs.readFileSync(path.join(propagationPaths(env).root, name), "utf8"),
  );
}
export function writePropagation(name, value, env) {
  const file = path.join(propagationPaths(env).root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  return value;
}
export function propagationOutputs(values) {
  writeGitHubOutputs(values);
}
