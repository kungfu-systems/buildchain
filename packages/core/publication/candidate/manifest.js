import fs from "node:fs";
import path from "node:path";

export async function readQualifiedManifest({ cwd, preparePaperPackage }) {
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(cwd, ".buildchain/publication/reproducibility-receipt.json"),
      "utf8",
    ),
  );
  const requireQualifying = preparePaperPackage;
  if (
    receipt.status !== "passed" ||
    (requireQualifying && receipt.qualifying !== true)
  ) {
    throw new Error(
      `publication reproducibility receipt is not qualifying: ${receipt.status}`,
    );
  }
  const publication = receipt.builds?.[0]?.publication || {};
  if (!publication.manifestPath || !publication.passportPath) {
    throw new Error(
      "publication reproducibility receipt is missing manifest paths",
    );
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(cwd, publication.manifestPath), "utf8"),
  );
  return {
    "manifest-path": publication.manifestPath,
    "passport-path": publication.passportPath,
    "registry-path": publication.registryPath || "",
    "manifest-json": JSON.stringify(manifest),
  };
}
