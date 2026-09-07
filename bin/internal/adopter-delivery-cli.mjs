import {
  loadPublishedAdopterDeliveryAuthority,
  qualifyAdopterDeliveryBootstrap,
  runAdopterDeliveryGate,
  verifyAdopterDeliveryReadback,
} from "../../packages/core/adopter-delivery.js";
import {
  printJson,
  readFlag,
  readJsonInput,
  writeJsonFile,
} from "./cli-options.mjs";

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
  if (subcommand === "bootstrap") {
    const request = readJsonInput(readFlag(commandArgs, "input", ""), {
      label: "adopter delivery bootstrap input",
    });
    emit(commandArgs, qualifyAdopterDeliveryBootstrap(request));
    return;
  }
  if (subcommand === "archive") {
    const request = readJsonInput(readFlag(commandArgs, "input", ""), {
      label: "published archive input",
    });
    const authority = await loadPublishedAdopterDeliveryAuthority(request);
    try {
      emit(commandArgs, {
        schemaVersion: authority.schemaVersion,
        contract: authority.contract,
        packages: authority.packages,
        moduleCoordinates: authority.moduleCoordinates,
        authorityRoot: authority.authorityRoot,
        qualifying: authority.qualifying,
        selfCertified: authority.selfCertified,
        releaseAuthorized: authority.releaseAuthorized,
        finalAuthority: authority.finalAuthority,
      });
    } finally {
      await authority.dispose();
    }
    return;
  }
  throw new Error(
    "usage: buildchain adopter-delivery <run|verify|bootstrap|archive> --input <json-or-path> [--readback <json-or-path>] [--output <path>]",
  );
}
