import * as core from "@actions/core";

// The host owns GitHub I/O and failure reporting. Domain orchestration belongs
// to the named handler; this is deliberately not a script or step interpreter.
export async function runAction(
  handler,
  toolkit = core,
  env = process.env,
  host = process,
) {
  try {
    return await handler(toolkit, env);
  } catch (error) {
    toolkit.setFailed(error instanceof Error ? error.message : String(error));
    if (Number.isInteger(error?.status) && error.status > 0)
      host.exitCode = error.status;
    return undefined;
  }
}
