import path from "node:path";
import { collectKfdAggregate } from "../kfd.js";
import { printJson, readBooleanFlag, readFlag } from "../../contracts/cli/options.mjs";

export async function runKfdAggregate(maybeStandardOrAction, rest) {
    const effectiveArgs =
      maybeStandardOrAction && maybeStandardOrAction.startsWith("--")
        ? [maybeStandardOrAction, ...rest]
        : rest;
    const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
    const result = collectKfdAggregate({ cwd });
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd aggregate: upstream=${result.upstream.summary.upstreamCount}, status=${result.upstreamCheck.status}\n`,
      );
    }
    return;
  }
