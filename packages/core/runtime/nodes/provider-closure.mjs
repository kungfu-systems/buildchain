import { pathToFileURL } from "node:url";
import { command, requireValue, runOperation } from "../action-process.mjs";
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({ verify });
