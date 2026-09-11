import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installLockedDependencies } from "../locked-dependencies.js";
import { preparedRuntimeSelection } from "./selection.js";

export function activateExecutionRuntime(
  { selection, workspace },
  {
    readCommit = (directory) =>
      execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    install = installLockedDependencies,
  } = {},
) {
  const selected = preparedRuntimeSelection(selection);
  const directory = path.resolve(workspace, ".buildchain/runtime");
  if (readCommit(directory).toLowerCase() !== selected.sha)
    throw new Error(
      "Runtime preparation acquired different bytes than selected",
    );
  const protocol = JSON.parse(
    fs.readFileSync(
      path.join(directory, "architecture/runtime-entry.json"),
      "utf8",
    ),
  );
  if (
    protocol.schema !== "buildchain.runtime-entry/v1" ||
    protocol.protocol !== selected.protocol
  )
    throw new Error(
      "Acquired runtime does not implement the admitted entry protocol",
    );
  const contractFile = path.join(
    directory,
    "dist/site/buildchain-contract.json",
  );
  const contract = JSON.parse(fs.readFileSync(contractFile, "utf8"));
  if (!/^sha256:[0-9a-f]{64}$/u.test(contract.contractDigest || ""))
    throw new Error("Prepared runtime distribution lacks a contract digest");
  if (
    selected.contract?.digest &&
    selected.contract.digest !== contract?.contractDigest
  )
    throw new Error("Selected runtime contract differs from the consumer lock");
  const { nodePath } = install({
    directory,
    production: true,
    ignoreScripts: true,
  });
  return { directory, nodePath, selection: selected, contract };
}

export function activateExecutionRuntimeAction(core, env) {
  const result = activateExecutionRuntime({
    selection: JSON.parse(core.getInput("selection", { required: true })),
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
  });
  // Execution identity is provenance. Only this preparation boundary validates it.
  core.exportVariable("BUILDCHAIN_RUNTIME_ROOT", result.directory);
  core.exportVariable(
    "BUILDCHAIN_CONTRACT_DIGEST",
    result.contract?.contractDigest || "",
  );
  core.exportVariable(
    "BUILDCHAIN_EXECUTION_SOURCE",
    JSON.stringify(result.selection.source || {}),
  );
  core.exportVariable("BUILDCHAIN_RUNTIME_SHA", result.selection.sha);
  core.exportVariable("BUILDCHAIN_RUNTIME_REF", result.selection.ref);
  core.exportVariable("BUILDCHAIN_RUNTIME_CLASS", result.selection.class);
  core.exportVariable("BUILDCHAIN_RUNTIME_ORIGIN", result.selection.origin);
  core.exportVariable(
    "BUILDCHAIN_RUNTIME_OVERRIDE",
    String(result.selection.origin === "runtime-parameter"),
  );
  core.exportVariable(
    "BUILDCHAIN_RUNTIME_SELECTION",
    JSON.stringify(result.selection),
  );
  core.exportVariable("BUILDCHAIN_NODE_PATH", result.nodePath);
  core.setOutput("directory", result.directory);
  core.setOutput("node-path", result.nodePath);
}
