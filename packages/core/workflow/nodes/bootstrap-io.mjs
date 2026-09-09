import fs from "node:fs";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";
export { writeGitHubOutputs as outputs } from "../../providers/commands/github-output.mjs";

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value) + "\n");
  return value;
}
export function engine(directory, operation, file, env = process.env) {
  const bytes = command(
    process.execPath,
    [
      `${directory}/packages/core/workflow/commands/universal-workflow-engine.mjs`,
      operation,
    ],
    { env, stdio: ["ignore", "pipe", "inherit"] },
  );
  const value = JSON.parse(bytes);
  writeJson(file, value);
  return value;
}
export function backflow(directory, file) {
  return writeJson(
    file,
    JSON.parse(
      command(
        process.execPath,
        [
          `${directory}/packages/core/workflow/commands/universal-workflow-backflow.mjs`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      ),
    ),
  );
}

export function candidateResultOutputs(value) {
  requireValue(
    value.schema === "kungfu-buildchain-v4-universal-workflow-result/v1" &&
      ["succeeded", "failed"].includes(value.status) &&
      /^sha256:[0-9a-f]{64}$/u.test(value.resultRoot || ""),
    "Candidate engine emitted an invalid result",
  );
  return {
    "result-json": JSON.stringify(value),
    "result-root": value.resultRoot,
  };
}
