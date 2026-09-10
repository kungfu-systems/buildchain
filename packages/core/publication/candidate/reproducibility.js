import fs from "node:fs";
import path from "node:path";
import { requireValue } from "../../runtime/action-process.mjs";
import { verifyPublicationReproducibility } from "../publication-reproducibility.js";
export function provePublicationReproducibility(
  { cwd, sourceSha, preparePaperPackage, packageName = "", toolchain },
  verify = verifyPublicationReproducibility,
) {
  const qualifying = preparePaperPackage;
  const result = verify({
    cwd,
    toolchain,
    sourceSha: sourceSha,
    output: ".buildchain/publication/reproducibility-receipt.json",
    promote: true,
    packageName: packageName,
    allowUnpinnedToolchain: !qualifying,
  });
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/publication-reproducibility-result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  requireValue(
    result.status === "passed" && (!qualifying || result.qualifying === true),
    "Publication reproducibility did not produce qualifying evidence",
  );
  return result;
}
