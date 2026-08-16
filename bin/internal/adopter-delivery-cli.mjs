import {
  loadV4PublishedAdopterDeliveryAuthority,
  qualifyV4AdopterDeliveryBootstrap,
  runV4AdopterDeliveryGate,
  verifyV4AdopterDeliveryReadback,
} from "../../packages/core/v4-adopter-delivery.js";
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
    emit(commandArgs, runV4AdopterDeliveryGate(input));
    return;
  }
  if (subcommand === "verify") {
    const input = readJsonInput(readFlag(commandArgs, "input", ""), {
      label: "adopter delivery input",
    });
    const readback = readJsonInput(readFlag(commandArgs, "readback", ""), {
      label: "adopter delivery readback",
    });
    emit(commandArgs, verifyV4AdopterDeliveryReadback({ input, readback }));
    return;
  }
  if (subcommand === "bootstrap") {
    const request = readJsonInput(readFlag(commandArgs, "input", ""), {
      label: "adopter delivery bootstrap input",
    });
    emit(commandArgs, qualifyV4AdopterDeliveryBootstrap(request));
    return;
  }
  if (subcommand === "archive") {
    const request = readJsonInput(readFlag(commandArgs, "input", ""), {
      label: "published archive input",
    });
    const authority = await loadV4PublishedAdopterDeliveryAuthority(request);
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
