import fs from "node:fs";

export async function readQualifiedManifest(env) {
  const receipt = JSON.parse(
    fs.readFileSync(
      ".buildchain/publication/reproducibility-receipt.json",
      "utf8",
    ),
  );
  const requireQualifying = env.INPUT_PREPARE_PAPER_PACKAGE === "true";
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
    fs.readFileSync(publication.manifestPath, "utf8"),
  );
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `manifest-path=${publication.manifestPath}\n`,
  );
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `passport-path=${publication.passportPath}\n`,
  );
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `registry-path=${publication.registryPath || ""}\n`,
  );
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `manifest-json=${JSON.stringify(manifest)}\n`,
  );
}
