import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  command,
  environmentArguments,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";

const runtime = ".buildchain/runtime";
const proofCommand = `${runtime}/packages/core/dev-delivery/commands/dev-delivery-source-proof-reuse.mjs`;
const request = (env) => JSON.parse(env.BUILDCHAIN_CHECK_REQUEST_JSON);
const output = (env, values) =>
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
export function sourceIdentities(env, execute = command) {
  const sourceSha = execute("git", ["rev-parse", "HEAD"], {
    stdio: "pipe",
  }).trim();
  const runtimeSha = execute("git", ["-C", runtime, "rev-parse", "HEAD"], {
    stdio: "pipe",
  }).trim();
  const contract = JSON.parse(
    fs.readFileSync(`${runtime}/dist/site/buildchain-contract.json`, "utf8"),
  );
  requireValue(
    /^[0-9a-f]{40}$/.test(sourceSha) && /^[0-9a-f]{40}$/.test(runtimeSha),
    "Exact source and runtime commits are required",
  );
  requireValue(
    /^sha256:[0-9a-f]{64}$/.test(contract.contractDigest),
    "Runtime contract digest is invalid",
  );
  output(env, {
    "source-sha": sourceSha,
    "runtime-sha": runtimeSha,
    "contract-digest": contract.contractDigest,
  });
}
export function sourceProofArguments(env, operation) {
  const input = request(env);
  requireValue(
    ["seal", "verify"].includes(operation),
    "Unknown source proof operation",
  );
  const branch = String(env.PROTECTED_BASE || "").replace(/^refs\/heads\//, "");
  return [
    proofCommand,
    operation,
    ...environmentArguments(
      {
        repository: "GITHUB_REPOSITORY",
        "source-head": "SOURCE_HEAD",
        "runtime-ref": "RUNTIME_REF",
        "runtime-sha": "RUNTIME_SHA",
        "contract-digest": "CONTRACT_DIGEST",
        "policy-paths-json": "POLICY_PATHS_JSON",
        "closure-paths-json": "CLOSURE_PATHS_JSON",
        "dependency-paths-json": "DEPENDENCY_PATHS_JSON",
        "required-contexts-json": "REQUIRED_CONTEXTS_JSON",
      },
      env,
    ),
    "--branch",
    branch,
    "--node-version",
    input["node-version"],
    "--working-directory",
    input["working-directory"],
    "--source-workflow-run-id",
    operation === "seal" ? env.GITHUB_RUN_ID : env.SOURCE_WORKFLOW_RUN_ID,
  ];
}
export function verifySourceProof(env, execute = command) {
  const proof = JSON.parse(
    fs.readFileSync(".buildchain/source-proof/source-proof.json", "utf8"),
  );
  const refs = {
    "merge-group-head": env.MERGE_GROUP_HEAD,
    "current-base": env.CURRENT_BASE,
    "source-head": env.SOURCE_HEAD,
    "qualified-base": proof.qualifiedBase,
  };
  requireValue(
    Object.values(refs).every((sha) => /^[0-9a-f]{40}$/.test(sha || "")),
    "Source proof requires exact commit coordinates",
  );
  execute("git", [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--depth=64",
    "origin",
    ...Object.entries(refs).map(
      ([name, sha]) => `+${sha}:refs/buildchain/source-proof/${name}`,
    ),
  ]);
  const tree = execute("git", ["rev-parse", "HEAD^{tree}"], {
    stdio: "pipe",
  }).trim();
  execute(process.execPath, [
    ...sourceProofArguments(env, "verify"),
    "--current-base",
    env.CURRENT_BASE,
    "--controller-receipt",
    ".buildchain/source-proof/controller-receipt.json",
    "--source-proof",
    ".buildchain/source-proof/source-proof.json",
    "--merge-group-head",
    env.MERGE_GROUP_HEAD,
    "--merge-group-tree",
    tree,
    "--verified-at",
    new Date().toISOString(),
    "--output",
    ".buildchain/source-proof/reuse-decision.json",
    "--manifest-output",
    ".buildchain/artifacts/check-manifest.json",
    "--summary-output",
    ".buildchain/artifacts/check-summary.json",
  ]);
}
export function sealSourceProof(env, execute = command) {
  execute(process.execPath, [
    ...sourceProofArguments(env, "seal"),
    "--qualified-base",
    env.QUALIFIED_BASE,
    "--controller-receipt",
    ".buildchain/controller/receipt.json",
    "--qualified-at",
    new Date().toISOString(),
    "--output",
    ".buildchain/source-proof/source-proof.json",
  ]);
  fs.copyFileSync(
    ".buildchain/controller/receipt.json",
    ".buildchain/source-proof/controller-receipt.json",
  );
}
export async function paperPolicy(env, execute = command) {
  const { loadBuildchainConfig } = await import(
    pathToFileURL(
      path.resolve(`${runtime}/packages/core/consumer/buildchain-config.js`),
    ).href
  );
  const cwd = path.resolve(request(env)["working-directory"] || ".");
  const config = loadBuildchainConfig(cwd)?.config;
  const paper =
    fs.existsSync(path.join(cwd, ".buildchain/paper")) ||
    config?.publish?.kind === "npm-paper-package" ||
    (config?.project?.type === "publication-artifact" &&
      (!config.publication || config.publication.kind === "paper"));
  if (paper) {
    requireValue(
      Boolean(env.BUILDCHAIN_RUNTIME_REF),
      "Paper policy requires the selected runtime coordinate",
    );
    execute(process.execPath, [
      `${runtime}/packages/core/paper/commands/paper.mjs`,
      "preflight",
      "--cwd",
      cwd,
      "--buildchain-ref",
      env.BUILDCHAIN_RUNTIME_REF,
      "--offline",
      "--ci",
      "--json",
    ]);
  } else console.log("Buildchain Paper policy: not applicable");
}
export function checkMode(env) {
  const mode = request(env).mode;
  requireValue(
    ["source", "verify"].includes(mode),
    `Unsupported check mode: ${mode}`,
  );
  output(env, { stage: mode === "source" ? "check" : "verify" });
}
export function lifecycleArguments(env, operation) {
  const input = request(env);
  const stage = env.BUILDCHAIN_LIFECYCLE_STAGE;
  requireValue(
    ["check", "verify"].includes(stage),
    "Invalid check lifecycle stage",
  );
  const cwd = input["working-directory"];
  if (operation === "validate")
    return [
      "validate",
      "--cwd",
      cwd,
      ...(input["require-version-state"] ? ["--require-version-state"] : []),
      "--require-lifecycle-stages",
      `install,${stage}`,
    ];
  requireValue(
    ["install", "check"].includes(operation),
    "Unknown check lifecycle operation",
  );
  const name = operation === "install" ? "check-install" : "check";
  return [
    "lifecycle",
    "run",
    operation === "install" ? "install" : stage,
    "--cwd",
    cwd,
    "--required",
    "--artifact-name",
    `buildchain-${name}`,
    "--manifest-path",
    `.buildchain/artifacts/${name}-manifest.json`,
    "--summary-path",
    `.buildchain/artifacts/${name}-summary.json`,
  ];
}
export async function checkLifecycle(env, operation) {
  const args = lifecycleArguments(env, operation);
  if (operation === "validate") {
    const { handleValidateCommand } = await import(
      pathToFileURL(
        path.resolve(`${runtime}/packages/core/adoption/cli/project.mjs`),
      ).href
    );
    return handleValidateCommand(args.slice(1));
  }
  const { handleLifecycleCommand } = await import(
    pathToFileURL(
      path.resolve(`${runtime}/packages/core/build/cli/lifecycle.mjs`),
    ).href
  );
  return handleLifecycleCommand(args.slice(1));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runOperation({
    identities: sourceIdentities,
    "verify-proof": verifySourceProof,
    "seal-proof": sealSourceProof,
    "paper-policy": paperPolicy,
    mode: checkMode,
    ...Object.fromEntries(
      ["validate", "install", "check"].map((operation) => [
        operation,
        (env) => checkLifecycle(env, operation),
      ]),
    ),
  });
}
