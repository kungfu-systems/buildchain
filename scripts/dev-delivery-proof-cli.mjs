#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  classifyDevDelta,
  createIntegrationDeliveryProof,
  createSourceQualificationProof,
  createSourceReplayReceipt,
  planSourceReplay,
  verifyDevDeltaClassification,
  verifyIntegrationDeliveryProof,
  verifySourceQualificationProof,
  verifySourceReplayReceipt,
} from "./dev-delivery-proof.mjs";
import {
  canonical,
  contentRoot,
  requiredText,
} from "./dev-delivery-warrant-contract.mjs";

export const DEV_DELIVERY_PROOF_OPERATION_SCHEMA =
  "kungfu-buildchain-dev-delivery-proof-operation/v1";

export function applyDevDeliveryProofOperation(operation, input = {}) {
  let result;
  switch (requiredText(operation, "proof operation")) {
    case "source-create":
      result = createSourceQualificationProof(input);
      break;
    case "source-verify":
      result = verifySourceQualificationProof(input.proof, input.expected);
      break;
    case "delta-classify":
      result = classifyDevDelta(input);
      break;
    case "delta-verify":
      result = verifyDevDeltaClassification(input.classification, {
        ...input.expected,
        sourceProof: input.sourceProof,
      });
      break;
    case "replay-plan":
      result = planSourceReplay(input);
      break;
    case "replay-receipt-create":
      result = createSourceReplayReceipt(input);
      break;
    case "replay-receipt-verify":
      result = verifySourceReplayReceipt(input.receipt, {
        ...input.expected,
        sourceProof: input.sourceProof,
        classification: input.classification,
      });
      break;
    case "integration-create":
      result = createIntegrationDeliveryProof(input);
      break;
    case "integration-verify":
      result = verifyIntegrationDeliveryProof(input.proof, {
        ...input.expected,
        providerReceipt: input.providerReceipt,
      });
      break;
    default:
      throw new Error(`unsupported proof operation '${operation}'`);
  }
  const receipt = canonical({
    schema: DEV_DELIVERY_PROOF_OPERATION_SCHEMA,
    operation,
    status: operation.endsWith("-verify") ? "verified" : "complete",
    result,
  });
  return { ...receipt, receiptRoot: contentRoot(receipt) };
}

function cliValue(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: buildchain dev proof --operation <source-create|source-verify|delta-classify|delta-verify|replay-plan|replay-receipt-create|replay-receipt-verify|integration-create|integration-verify> --input FILE [--output FILE]\n",
    );
    return;
  }
  const operation = cliValue(args, "operation");
  const inputPath = requiredText(cliValue(args, "input"), "input file");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result = applyDevDeliveryProofOperation(operation, input);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = cliValue(args, "output");
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output);
  }
  process.stdout.write(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
