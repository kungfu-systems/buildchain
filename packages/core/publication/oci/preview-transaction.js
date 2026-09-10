import fs from "node:fs";
import path from "node:path";
import { admitComposePreview } from "./preview-admission.js";
import { check, read, digest } from "./preview-values.js";
import { verifyComposeQualification } from "../oci-compose-qualification.js";
import { promoteComposePreview } from "./preview-promotion.js";
import { previewManifestReader } from "./preview-registry.js";
export async function applyComposePreview(
  request,
  { provider, registry, admit = admitComposePreview },
) {
  // Re-read public release and run state under the write principal before any registry mutation.
  const { root, context, run, release, runId } = await admit(request, provider);
  const evidenceRoot = path.join(root, "qualification");
  const receipt = read(path.join(evidenceRoot, "qualification.json"));
  verifyComposeQualification(context, run, receipt);
  for (const item of receipt.evidence) {
    const file = path.join(evidenceRoot, item.path),
      stat = fs.lstatSync(file);
    check(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size < 2_000_000 &&
        digest(fs.readFileSync(file)) === item.sha256,
      "qualification evidence bytes mismatch",
    );
  }
  const result = await promoteComposePreview({
    context,
    registry,
    receipt,
    fetchManifest: previewManifestReader(context.application, registry),
  });
  const file = path.join(
    root,
    `buildchain-compose-preview-${runId}-${run.run_attempt}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  // Shared provider reconciles immutable bytes and verifies the uploaded receipt by readback.
  await provider.publish(release, [file]);
  return result;
}
