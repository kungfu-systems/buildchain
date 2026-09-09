import { normalizePassportCollectionOptions } from "./collection-options.js";
import { readPassportCollectionInputs } from "./collection-inputs.js";
import { preparePassportCollectionMaterial } from "./collection-material.js";
import { writePassportCollection } from "./collection-output.js";
export function collectGitHubReleasePassport(options = {}) {
  const context = normalizePassportCollectionOptions(options);
  Object.assign(context, readPassportCollectionInputs(context));
  Object.assign(context, preparePassportCollectionMaterial(context));
  return writePassportCollection(context);
}
