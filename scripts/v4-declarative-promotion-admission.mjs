#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { assertV4DeclarativePromotionInputs } from "../packages/core/v4-publication-qualification.js";

export function admitV4DeclarativePromotion({
  inputs,
  runtimeRef,
  declarative,
}) {
  if (
    declarative !== true &&
    !/^v4(?:$|[-./])/u.test(String(runtimeRef || ""))
  ) {
    return Object.freeze({ mode: "legacy", admitted: true });
  }
  if (declarative !== true) {
    const error = new Error(
      "Buildchain v4 release-candidate-promote requires declarative-release-tail=true",
    );
    error.code = "v4-declarative-release-tail-required";
    throw error;
  }
  assertV4DeclarativePromotionInputs(inputs);
  return Object.freeze({ mode: "v4-declarative", admitted: true });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = admitV4DeclarativePromotion({
      inputs: JSON.parse(process.env.BUILDCHAIN_PROMOTION_INPUTS_JSON || "{}"),
      runtimeRef: process.env.BUILDCHAIN_RUNTIME_REF,
      declarative: process.env.BUILDCHAIN_DECLARATIVE_RELEASE_TAIL === "true",
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `v4-declarative-promotion-admission: ${error.code || "rejected"}: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
