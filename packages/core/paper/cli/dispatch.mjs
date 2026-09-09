import { runPaperCli } from "../commands/paper.mjs";
import {
  embeddedSourceSha,
  packageVersion,
  root,
} from "../../contracts/cli/context.mjs";

export async function handlePaperCommand(args) {
  await runPaperCli(args, {
    buildchainRoot: root,
    buildchainVersion: packageVersion(),
    buildchainRef: process.env.BUILDCHAIN_RUNTIME_REF || "v4-alpha",
    buildchainSha:
      process.env.BUILDCHAIN_RUNTIME_SHA || embeddedSourceSha || "",
  });
  return;
}
