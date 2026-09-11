import fs from "node:fs";
import path from "node:path";

export function propagationPaths(context) {
  if (!path.isAbsolute(context.workspace || ""))
    throw new Error("Propagation requires an explicit absolute workspace");
  const workspace = context.workspace;
  return {
    workspace,
    root: path.join(workspace, ".buildchain/release-propagation"),
    runtime: path.join(workspace, ".buildchain/runtime"),
    downstream: path.join(workspace, "downstream"),
  };
}
export const request = (context) => context.request;
export function readPropagation(name, context) {
  return JSON.parse(
    fs.readFileSync(path.join(propagationPaths(context).root, name), "utf8"),
  );
}
export function writePropagation(name, value, context) {
  const file = path.join(propagationPaths(context).root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  return value;
}
