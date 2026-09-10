import fs from "node:fs";
import path from "node:path";
import { commandForPlatform, parseJson, readJson, writeJson } from "./files.js";
import { runGateCommand, gateArgs } from "./commands.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
export function prepareGateExecutionFiles(files) {
  for (const file of files) fs.rmSync(file, { force: true });
}
export async function executeGateProfile(
  { entry, commandJson, registry, cwd, outputRoot, environment },
  execute = runGateCommand,
) {
  const receiptPath = path.join(outputRoot, "receipt.json");
  const validationPath = path.join(outputRoot, "validation.json");
  const executionPath = path.join(outputRoot, "execution.json");
  const session = consumerCommandSession(environment);
  fs.mkdirSync(outputRoot, { recursive: true });
  prepareGateExecutionFiles([receiptPath, validationPath, executionPath]);
  const argv = commandForPlatform(commandJson, entry.platform);
  const runArgs = gateArgs(
    [
      "gate",
      "run",
      "--profile",
      entry.profile,
      ...(entry.includeAdvisory ? ["--include-advisory"] : []),
      ...entry.capabilities.flatMap((capability) => [
        "--capability",
        capability,
      ]),
      "--receipt",
      receiptPath,
      "--json",
    ],
    registry,
  );
  const runResult = await session.phase((env) =>
    execute(argv, runArgs, {
      cwd,
      env,
      allowFailure: true,
      streamOutput: true,
    }),
  );
  let receipt = fs.existsSync(receiptPath)
    ? readJson(receiptPath, "Shifu gate receipt")
    : null;
  let validation = null;
  let validationStatus = 1;
  if (receipt) {
    const validationResult = await session.phase((env) =>
      execute(
        argv,
        gateArgs(
          ["gate", "receipt", "validate", receiptPath, "--json"],
          registry,
        ),
        { cwd, env, allowFailure: true },
      ),
    );
    validationStatus = validationResult.status;
    if (validationResult.stdout.trim()) {
      validation = parseJson(
        validationResult.stdout,
        "Shifu gate receipt validation",
      );
      writeJson(validationPath, validation);
    }
  }
  const execution = {
    platformId: entry.id,
    runStatus: runResult.status,
    validationStatus,
    receipt,
    validation,
  };
  writeJson(executionPath, execution);
  return {
    execution,
    receiptPath: receipt ? receiptPath : "",
    validationPath: validation ? validationPath : "",
    executionPath,
    qualifying:
      runResult.status === 0 &&
      validationStatus === 0 &&
      validation?.qualifying === true,
  };
}
