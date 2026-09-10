import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";

export function printKfdSchemaOrJson({ result, json }) {
  if (json) {
    printJson(result);
  } else {
    process.stdout.write(JSON.stringify(result.schema, null, 2));
    process.stdout.write("\n");
  }
}
