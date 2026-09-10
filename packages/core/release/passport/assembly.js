import { normalizePassportOptions } from "./assembly-inputs.js";
import {
  preparePassportSections,
  preparePassportReleaseIdentity,
} from "./assembly-material.js";
import { renderReleasePassport } from "./assembly-render.js";
export function createReleasePassport(options = {}) {
  const context = normalizePassportOptions(options);
  Object.assign(context, preparePassportSections(context));
  Object.assign(context, preparePassportReleaseIdentity(context));
  return renderReleasePassport(context);
}
