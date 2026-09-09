import { normalizeKfdStandardId } from "../kfd.js";
import { runKfdProductGateCli } from "./product-gate.mjs";
import { runKfd1Cli, runKfd2Cli } from "./standards.mjs";
import { runKfdSupportCli } from "./support.mjs";
import { runKfd3Cli } from "./surface-register.mjs";
import { runKfdHub } from "./kfd-hub.mjs";
import { runKfdStatus } from "./kfd-status.mjs";
import { runKfdLayoutMigration } from "./kfd-migrate-layout.mjs";
import { runKfdSchema } from "./kfd-schema.mjs";
import { runKfdUpstream } from "./kfd-upstream.mjs";
import { runKfdAggregate } from "./kfd-aggregate.mjs";

export async function runKfdCli(args = []) {
  const [subcommand = "", maybeStandardOrAction = "", ...rest] = args;
  if (!subcommand) {
    throw new Error(
      "usage: buildchain kfd <status|migrate-layout|schema|upstream|aggregate|hub|support|1|2|3|4|5|7> ...",
    );
  }

  if (subcommand === "hub") return runKfdHub(maybeStandardOrAction, rest);

  if (subcommand === "status") return runKfdStatus(maybeStandardOrAction, rest);

  if (subcommand === "migrate-layout") return runKfdLayoutMigration(maybeStandardOrAction, rest);

  if (subcommand === "schema") return runKfdSchema(maybeStandardOrAction, rest);

  if (subcommand === "upstream") return runKfdUpstream(maybeStandardOrAction, rest);

  if (subcommand === "aggregate") return runKfdAggregate(maybeStandardOrAction, rest);

  if (subcommand === "support") {
    runKfdSupportCli([maybeStandardOrAction, ...rest]);
    return;
  }

  const standard = normalizeKfdStandardId(subcommand);
  if (standard === "kfd-1") {
    runKfd1Cli([maybeStandardOrAction, ...rest]);
    return;
  }
  if (standard === "kfd-2") {
    runKfd2Cli([maybeStandardOrAction, ...rest]);
    return;
  }
  if (standard === "kfd-3") {
    await runKfd3Cli([maybeStandardOrAction, ...rest]);
    return;
  }
  if (["kfd-4", "kfd-5", "kfd-7"].includes(standard)) {
    await runKfdProductGateCli(standard, [maybeStandardOrAction, ...rest]);
    return;
  }
  throw new Error(
    "usage: buildchain kfd <status|migrate-layout|schema|upstream|aggregate|hub|support|1|2|3|4|5|7> ...",
  );
}

export async function handleKfdCommand(args) {
  await runKfdCli(args);
  return;
}
