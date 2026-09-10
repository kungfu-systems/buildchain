import { command, requireValue } from "./action-process.mjs";
import fs from "node:fs";
import path from "node:path";
import { installLockedDependencies } from "./locked-dependencies.js";
export function verify(env, execute = command) {
  for (const name of ["RUNTIME_SHA", "RUNTIME_TREE"])
    requireValue(
      /^[0-9a-f]{40}$/u.test(env[name] || ""),
      `${name} must be an immutable 40-hex identity`,
    );
  for (const [revision, expected] of [
    ["HEAD", env.RUNTIME_SHA],
    ["HEAD^{tree}", env.RUNTIME_TREE],
  ]) {
    const actual = execute(
      "git",
      ["-C", ".buildchain/runtime", "rev-parse", revision],
      { stdio: ["ignore", "pipe", "inherit"] },
    ).trim();
    requireValue(
      actual === expected,
      `Admitted runtime ${revision} does not match the checked-out closure`,
    );
  }
}

export function exposeProviderDependencies(workspace = process.cwd()) {
  const target = path.resolve(workspace, ".buildchain/runtime/node_modules");
  const link = path.resolve(workspace, "node_modules");
  requireValue(
    fs.statSync(target).isDirectory(),
    "Verified provider dependencies are missing",
  );
  // Existing source-owned dependencies must never be replaced by this boundary.
  fs.symlinkSync(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
}

export function activateProviderClosure(identity, ports = {}) {
  (ports.verify || verify)({
    RUNTIME_SHA: identity.sha,
    RUNTIME_TREE: identity.tree,
  });
  (ports.install || installLockedDependencies)({
    directory: ".buildchain/runtime",
    production: false,
    ignoreScripts: true,
  });
  (ports.expose || exposeProviderDependencies)();
}

export function providerClosureAction(core) {
  activateProviderClosure({
    sha: core.getInput("sha", { required: true }),
    tree: core.getInput("tree", { required: true }),
  });
}
