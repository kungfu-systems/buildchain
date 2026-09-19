import { readReleaseEvidenceAssets } from "./release-evidence-assets.js";

const NAMES = [
  "plan",
  "qualification",
  "capsules",
  "invocation",
  "attestation",
  "release",
];
export async function readPipelineReleaseEvidence(host, candidate) {
  const result = await readReleaseEvidenceAssets(
    host,
    candidate,
    NAMES.map((id) => `buildchain.${id}.json`),
  );
  if (result.status !== "present") return result;
  const values = {};
  for (const id of NAMES.filter((name) => name !== "attestation"))
    values[id] = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        result.values[`buildchain.${id}.json`],
      ),
    );
  return {
    ...result,
    values,
    bundle: result.values["buildchain.attestation.json"],
  };
}
