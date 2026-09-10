import { runScript } from "../../workflow/cli/process.mjs";

export async function handleWebSurfaceCommand(args) {
  runScript("packages/core/web/commands/web-surface.mjs", args);
  return;
}
