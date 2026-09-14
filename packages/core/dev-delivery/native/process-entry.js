// Node Actions receive artifact/OIDC authority even without token inputs.
// Replace the process before candidate work so the original environment is
// absent from /proc, memory and ancestry. A scrubbed child would retain it.
export function replaceNativeActionProcess(host = process) {
  const injected = ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!injected.some((name) => host.env[name])) return;
  if (host.platform !== "linux" || typeof host.execve !== "function") {
    throw new Error("credentialless native action requires Linux execve");
  }
  const environment = { ...host.env };
  for (const name of injected) delete environment[name];
  // Other credential-like variables remain subject to the ancestry guard.
  host.execve(
    host.execPath,
    [host.execPath, ...host.execArgv, ...host.argv.slice(1)],
    environment,
  );
  throw new Error("credentialless native process replacement returned");
}
