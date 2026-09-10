import {
  runAdopterDeliveryGate,
  verifyAdopterDeliveryReadback,
} from "../adopter-delivery.js";
import {
  printJson,
  readFlag,
  readJsonInput,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";

function emit(args, value) {
  writeJsonFile(readFlag(args, "output", ""), value);
  printJson(value);
}

export async function runAdopterDeliveryCli(args = []) {
  const [subcommand = "", ...commandArgs] = args;
  if (subcommand === "run") {
    const input = readJsonInput(readFlag(commandArgs, "input", ""), {
      label: "adopter delivery input",
    });
    emit(commandArgs, runAdopterDeliveryGate(input));
    return;
  }
  if (subcommand === "verify") {
    const input = readJsonInput(readFlag(commandArgs, "input", ""), {
      label: "adopter delivery input",
    });
    const readback = readJsonInput(readFlag(commandArgs, "readback", ""), {
      label: "adopter delivery readback",
    });
    emit(commandArgs, verifyAdopterDeliveryReadback({ input, readback }));
    return;
  }
  throw new Error(
    "usage: buildchain adopter-delivery <run|verify> --input <json-or-path> [--readback <json-or-path>] [--output <path>]",
  );
}
