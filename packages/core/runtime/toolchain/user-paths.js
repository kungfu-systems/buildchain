import os from "node:os";
import path from "node:path";
export function exposeUserToolchainAction(core) {
  for (const directory of [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
  ])
    core.addPath(directory);
}
