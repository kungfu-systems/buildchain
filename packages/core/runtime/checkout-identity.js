import { command } from "./action-process.mjs";
export function verifyCheckoutIdentity(
  { directory, sha, label = "Checkout" },
  execute = command,
) {
  if (!/^[0-9a-f]{40}$/.test(sha || ""))
    throw new Error(`${label} must be an exact commit`);
  const actual = execute("git", ["-C", directory, "rev-parse", "HEAD"], {
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  if (actual !== sha)
    throw new Error(`${label} does not match the checked-out commit`);
  return actual;
}
export function verifySourceRuntimeCheckouts(
  { sourceDirectory, sourceSha, runtimeDirectory, runtimeSha },
  execute = command,
) {
  verifyCheckoutIdentity(
    { directory: runtimeDirectory, sha: runtimeSha, label: "Runtime" },
    execute,
  );
  verifyCheckoutIdentity(
    { directory: sourceDirectory, sha: sourceSha, label: "Source" },
    execute,
  );
}
