import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { scanConsumerPolicy } from "../../consumer/policy-scan.js";

export function selectAdopter({ request, repository, sourceSha, runtimeSha }) {
  const external = [
    request["consumer-repository"],
    request["consumer-ref"],
    request["invocation-source-path"],
  ];
  if (
    external.some(Boolean) &&
    (!/^[\w.-]+\/[\w.-]+$/.test(external[0] || "") ||
      !/^[0-9a-f]{40}$/i.test(external[1] || "") ||
      !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(external[2] || ""))
  )
    throw new Error(
      "External adopter requires repository, exact commit and public invocation path together",
    );
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(request.consumer || ""))
    throw new Error("Adopter identity must be stable lowercase");
  const sha = String(request["consumer-ref"] || sourceSha).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error("Adopter requires an exact consumer commit");
  return { repository: request["consumer-repository"] || repository, sha };
}
export function verifyAdopterCheckouts(
  { runtimeRoot, consumerRoot, runtimeSha, consumerSha },
  execute = command,
) {
  for (const [directory, sha] of [
    [consumerRoot, consumerSha],
  ]) {
    if (
      !/^[0-9a-f]{40}$/i.test(sha || "") ||
      execute("git", ["-C", directory, "rev-parse", "HEAD"], {
        stdio: "pipe",
      }).trim() !== sha.toLowerCase()
    )
      throw new Error("Adopter checkout drifted from exact admission");
  }
}
export function adopterInputFile(root, relative) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((part) => !part || part === ".." || part === ".")
  )
    throw new Error("Adopter input must be repository-relative");
  const file = fs.realpathSync(path.join(root, relative));
  if (
    !file.startsWith(fs.realpathSync(root) + path.sep) ||
    !fs.statSync(file).isFile()
  )
    throw new Error("Adopter input escapes consumer repository");
  return file;
}
export function admitAdopterPolicy({
  runtimeRoot,
  consumerRoot,
  runtimeSha,
  consumerSha,
  repository,
  invocationSourcePath,
  inputPath,
}) {
  verifyAdopterCheckouts({
    runtimeRoot,
    consumerRoot,
    runtimeSha,
    consumerSha,
  });
  adopterInputFile(consumerRoot, inputPath);
  const output = path.join(
    consumerRoot,
    ".buildchain/evidence/adopter-delivery-policy-receipt.json",
  );
  const result = scanConsumerPolicy({
    runtimeRoot,
    root: consumerRoot,
    invocationRoot: consumerRoot,
    repository,
    sourceSha: consumerSha,
    invokedWorkflow: ".github/workflows/public-build-adopter-qualification.yml",
    invocationSourcePath,
    resolvedWorkflowSha: runtimeSha,
    resolvedRuntimeSha: runtimeSha,
    stableLockPath: ".buildchain/contract-lock.json",
    alphaLockPath: ".buildchain/alpha-contract-lock.json",
    output,
  });
  return { result, output };
}
