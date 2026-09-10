import fs from "node:fs";
import path from "node:path";
import { observeDevDeliveryQueue } from "../dev-delivery-warrant.js";
import { runDeliveryWarrantReadCandidate } from "../delivery-warrant-read-candidate.js";
import { text, positiveInteger } from "./values.js";
export async function observeQueue(loaded, options) {
  const readMode = text(options.readMode || "v3").toLowerCase();
  if (!["v3", "v4"].includes(readMode))
    throw new Error("readMode must be v3 or v4");
  let observation = observeDevDeliveryQueue(loaded.queue, {
    now: options.now,
  });
  let readCandidate;
  if (readMode === "v4") {
    const qualification =
      options.readQualification ||
      JSON.parse(fs.readFileSync(options.readQualificationPath, "utf8"));
    const retain =
      options.retainReadEvidence ||
      (async (evidence) => {
        if (!options.readEvidenceOutput)
          throw new Error("readEvidenceOutput is required");
        fs.mkdirSync(path.dirname(options.readEvidenceOutput), {
          recursive: true,
        });
        fs.writeFileSync(
          options.readEvidenceOutput,
          `${JSON.stringify(evidence, null, 2)}\n`,
        );
        return { receiptRoot: evidence.evidenceRoot };
      });
    readCandidate = await runDeliveryWarrantReadCandidate(loaded.queue, {
      qualification,
      expectedQualificationRoot: options.readQualificationRoot,
      expectedSources: {
        typescriptRevision: options.readTypescriptRevision,
        rustRevision: options.readRustRevision,
        validatorVersion: options.readValidatorVersion,
      },
      observedAt: options.now,
      timeoutMs: positiveInteger(options.readTimeoutMs, "readTimeoutMs", 5_000),
      signal: options.readSignal,
      invokeRust: options.invokeV4ReadHost,
      host: options.readHost,
      retain,
    });
    observation = readCandidate.observation;
  }
  return {
    schema: "kungfu.buildchain.dev-delivery-command-result/v1",
    ok: true,
    mode: "observe",
    readMode,
    stateRef: options.stateRef,
    stateCommit: loaded.commitSha,
    observation,
    ...(readCandidate ? { readCandidate } : {}),
  };
}
