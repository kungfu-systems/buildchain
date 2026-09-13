import {
  recordDigest,
  validateRuntime,
} from "../../release/discussion/envelope.js";
import { validateConsumerSource } from "../../workflow/attempt/identity.js";
import { pipelinePlatforms } from "../../workflow/pipeline/platforms.js";
import { choice, text } from "../../consumer/contract/shape.js";
import { pipelineVersionMaterialPaths } from "./version-regeneration.js";

export function planPipelineVersionPreparation({
  attempt,
  generation,
  source,
  contract,
  version,
  runtime,
  purpose,
  parentRoot,
}) {
  text(attempt, "version preparation attempt", /^attempt-[0-9a-f]{64}$/u);
  text(generation, "version preparation generation", /^sha256:[0-9a-f]{64}$/u);
  text(parentRoot, "version preparation parent", /^sha256:[0-9a-f]{64}$/u);
  text(
    source.repository,
    "version preparation repository",
    /^[\w.-]+\/[\w.-]+$/u,
  );
  validateConsumerSource(source, source.repository);
  validateRuntime(runtime);
  choice(
    runtime.repository,
    ["kungfu-systems/buildchain"],
    "version preparation runtime",
  );
  choice(
    purpose,
    ["publication", "development"],
    "version preparation purpose",
  );
  text(
    version,
    "version preparation target",
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
  );
  pipelineVersionMaterialPaths(contract.version, source.configPath);
  const body = {
    schema: "buildchain.pipeline-version-preparation/v1",
    attempt,
    generation,
    source,
    version,
    runtime,
    purpose,
    parentRoot,
    contractRoot: recordDigest(contract),
    versionPolicy: contract.version,
    platforms: pipelinePlatforms(contract).map(({ platform }) => platform),
  };
  return structuredClone({ ...body, root: recordDigest(body) });
}

export function verifyPipelineVersionPreparation(preparation, contract) {
  const expected = planPipelineVersionPreparation({ ...preparation, contract });
  if (recordDigest(preparation) !== recordDigest(expected))
    throw new Error(
      "Version preparation changed its source-bound product contract or root",
    );
  return preparation;
}
