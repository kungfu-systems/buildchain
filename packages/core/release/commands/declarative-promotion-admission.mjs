#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { assertDeclarativePromotionInputs } from "../../publication/publication-qualification.js";

export function admitDeclarativePromotion({ inputs }) {
  assertDeclarativePromotionInputs(inputs);
  return Object.freeze({ mode: "declarative", admitted: true });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = admitDeclarativePromotion({
      inputs: JSON.parse(process.env.BUILDCHAIN_PROMOTION_INPUTS_JSON || "{}"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `v4-declarative-promotion-admission: ${error.code || "rejected"}: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
