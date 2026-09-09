import path from "node:path";
import { layout as buildchainLayout } from "../kfd.js";
import { printJson, readBooleanFlag, readFlag } from "../../contracts/cli/options.mjs";

export async function runKfdLayoutMigration(maybeStandardOrAction, rest) {
    const effectiveArgs =
      maybeStandardOrAction && maybeStandardOrAction.startsWith("--")
        ? [maybeStandardOrAction, ...rest]
        : rest;
    const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
    const result = buildchainLayout.migrate({
      cwd,
      write: readBooleanFlag(effectiveArgs, "write"),
      force: readBooleanFlag(effectiveArgs, "force"),
    });
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd migrate-layout: ${result.status}${result.write ? " (write)" : " (dry-run)"}\n`,
      );
      for (const move of result.moves) {
        process.stdout.write(`- ${move.from} -> ${move.to}\n`);
      }
    }
    return;
  }
