import os from "node:os";
import { prepareWindowsRust } from "./windows-rust.js";
export function prepareWindowsRustAction(core, env) {
  const prepared = prepareWindowsRust({
    toolchain: core.getInput("toolchain", { required: true }),
    runnerTemp: env.RUNNER_TEMP || os.tmpdir(),
    distServer: core.getInput("dist-server"),
    updateRoot: core.getInput("update-root"),
    environment: env,
  });
  for (const [name, value] of Object.entries(prepared.variables))
    core.exportVariable(name, value);
  for (const directory of prepared.paths) core.addPath(directory);
}
