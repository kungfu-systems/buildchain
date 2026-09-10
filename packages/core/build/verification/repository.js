import { command } from "../../runtime/action-process.mjs";
export function verifyRepository({ workspace, env }, execute = command) {
  return execute("pnpm", ["run", "check"], { cwd: workspace, env });
}
