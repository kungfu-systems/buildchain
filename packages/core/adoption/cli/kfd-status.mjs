import path from "node:path";
import { collectKfdStatus } from "../kfd.js";
import { printJson, readBooleanFlag, readFlag } from "../../contracts/cli/options.mjs";

export async function runKfdStatus(maybeStandardOrAction, rest) {
    const effectiveArgs =
      maybeStandardOrAction && maybeStandardOrAction.startsWith("--")
        ? [maybeStandardOrAction, ...rest]
        : rest;
    const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
    const result = collectKfdStatus({ cwd });
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`kfd status: layout=${result.layout.status}\n`);
      for (const [standard, capabilities] of Object.entries(result.support)) {
        process.stdout.write(`- ${standard}: ${capabilities.join(", ")}\n`);
      }
    }
    return;
  }
