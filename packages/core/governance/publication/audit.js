import fs from "node:fs";
import path from "node:path";
import { collectPublicationControlPlane } from "./collection.js";
import { createPublicationControlPlaneReader } from "../../providers/github/publication-control-plane.js";
export function auditPublicationControlPlane(
  request,
  {
    reader = createPublicationControlPlaneReader(request),
    outputPath,
    allowNonqualifying = false,
  } = {},
) {
  const receipt = collectPublicationControlPlane(request, reader);
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  const failed = receipt.facts
    .filter((entry) => entry.status !== "pass")
    .map((entry) => entry.id);
  if (failed.length && !allowNonqualifying)
    throw new Error(
      `publication control-plane audit is non-qualifying: ${failed.join(", ")}`,
    );
  return receipt;
}
