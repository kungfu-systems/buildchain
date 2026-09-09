import { outputs, readEvidence, runtimeCommand } from "./io.mjs";
import {
  environmentArguments,
  runOperation,
} from "../../runtime/action-process.mjs";
import {
  verifyReservationReadback,
  reservationOutputs,
} from "./reservation-readback.mjs";
import { dispatchHandoff } from "./reservation-handoff.mjs";
await runOperation({
  select: (env) => {
    runtimeCommand("dev-delivery-warrant", [
      "select",
      ...environmentArguments(
        {
          repository: "GITHUB_REPOSITORY",
          branch: "TARGET_BRANCH",
          "lease-seconds": "LEASE_SECONDS",
        },
        env,
      ),
      "--execute",
      "--output",
      ".buildchain/dev-delivery/warrant.json",
    ]);
    const result = readEvidence("warrant.json");
    const warrant = verifyReservationReadback(result);
    if (
      warrant.pullRequestNumber !== Number(env.EXPECTED_PR) ||
      warrant.sourceHead !== env.EXPECTED_HEAD
    )
      dispatchHandoff(warrant, result, env);
    else outputs(reservationOutputs(result, warrant));
  },
});
