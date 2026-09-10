import fs from "node:fs";
import path from "node:path";
import { verifySealedAdmission } from "./verification.js";
export async function qualifyPublicationAuthority(
  input,
  verify = verifySealedAdmission,
) {
  const result = input.request.dryRun
    ? {
        capability: {
          schemaVersion: 1,
          contract: "kungfu-buildchain-publication-capability-dry-run",
          decision: "dry-run",
        },
        gateAggregate: null,
      }
    : await verify(input);
  const root = path.join(input.workspace, ".buildchain/publication-authority");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "capability.json"),
    `${JSON.stringify(result.capability, null, 2)}\n`,
  );
  if (result.gateAggregate)
    fs.writeFileSync(
      path.join(root, "gate-aggregate.json"),
      `${JSON.stringify(result.gateAggregate, null, 2)}\n`,
    );
  return {
    "capability-json": JSON.stringify(result.capability),
    "capability-digest": result.capability.capabilityDigest || "",
    "gate-aggregate-json": result.gateAggregate
      ? JSON.stringify(result.gateAggregate)
      : "",
    "gate-aggregate-digest": result.gateAggregate?.digest || "",
  };
}
