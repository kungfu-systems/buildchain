import { listKfdSchemas, readKfdSchema } from "../kfd.js";
import { printJson, readBooleanFlag, readFlag } from "../../contracts/cli/options.mjs";

export async function runKfdSchema(maybeStandardOrAction, rest) {
    const [schemaCommand = "", maybeStandard = "", ...schemaRest] = [
      maybeStandardOrAction,
      ...rest,
    ];
    const effectiveArgs =
      maybeStandard && maybeStandard.startsWith("--")
        ? [maybeStandard, ...schemaRest]
        : schemaRest;
    const json = readBooleanFlag(effectiveArgs, "json");
    if (schemaCommand === "list") {
      const result = listKfdSchemas({
        standard: readFlag(effectiveArgs, "standard", ""),
      });
      if (json) {
        printJson(result);
      } else {
        process.stdout.write(
          `kfd schema list: ${result.schemas.length} schemas\n`,
        );
        for (const entry of result.schemas) {
          process.stdout.write(
            `- ${entry.standard}:${entry.name} ${entry.schemaId || entry.schemaPath}\n`,
          );
        }
      }
      return;
    }
    if (schemaCommand === "show") {
      const standard =
        maybeStandard && !maybeStandard.startsWith("--")
          ? maybeStandard
          : readFlag(effectiveArgs, "standard", "");
      if (!standard) {
        throw new Error(
          "usage: buildchain kfd schema show <kfd-1..kfd-13> [--schema <name>]",
        );
      }
      const result = readKfdSchema({
        standard,
        schema: readFlag(effectiveArgs, "schema", ""),
      });
      if (json) {
        printJson(result);
      } else {
        process.stdout.write(JSON.stringify(result.schema, null, 2));
        process.stdout.write("\n");
      }
      return;
    }
    throw new Error("usage: buildchain kfd schema <list|show> ...");
  }
