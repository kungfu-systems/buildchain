import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
export function controllerCheckoutIdentity(
  { workspace, runtimeRoot, runtimeSha = process.env.BUILDCHAIN_RUNTIME_SHA },
  execute = command,
) {
  const sha = (directory) =>
    execute("git", ["-C", directory, "rev-parse", "HEAD"], {
      stdio: "pipe",
    }).trim();
  const sourceSha = sha(workspace);
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(runtimeRoot, "dist/site/buildchain-contract.json"),
      "utf8",
    ),
  );
  if (
    !/^[0-9a-f]{40}$/.test(sourceSha) ||
    !/^sha256:[0-9a-f]{64}$/.test(contract.contractDigest)
  )
    throw new Error(
      "Exact source and contract evidence are required",
    );
  return {
    "source-sha": sourceSha,
    "runtime-sha": runtimeSha,
    "contract-digest": contract.contractDigest,
  };
}
