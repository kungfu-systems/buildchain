import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readPublishedPaper } from "./readback.js";
import { requirePaperReleasePassport } from "../publication-controller.js";

export async function sealReleaseEnvelope(publication) {
  await readPublishedPaper(publication);
  requirePaperReleasePassport(
    JSON.parse(fs.readFileSync(publication.passportPath, "utf8")),
    {
      repository: publication.repository,
      sourceSha: publication.sourceSha,
      tag: publication.releaseTag,
    },
  );
  const sha256File = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const canonicalPublicationFile = (name) => {
    const file = path.join(
      publication.workspace,
      ".buildchain/admitted/artifact/.buildchain/publication",
      name,
    );
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`canonical publication file is missing: ${file}`);
    }
    return file;
  };
  const packageFact = JSON.parse(
    fs.readFileSync(
      path.join(publication.workspace, ".buildchain/published-package.json"),
      "utf8",
    ),
  );
  if (packageFact.version !== publication.packageVersion)
    throw new Error("npm version readback mismatch");
  const packageIntegrity = packageFact.dist?.integrity;
  if (!packageIntegrity?.startsWith("sha512-"))
    throw new Error("npm integrity readback is missing");
  if (packageFact.gitHead !== publication.sourceSha)
    throw new Error("npm gitHead readback does not match source SHA");
  if (publication.releaseTag !== `v${publication.packageVersion}`)
    throw new Error("public release tag does not match package version");

  const manifestPath = canonicalPublicationFile("publication-artifact.json");
  const passportPath = canonicalPublicationFile(
    "publication-artifact-passport.json",
  );
  const registryPath = canonicalPublicationFile("publication-registry.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const archive = manifest.publication?.archive;
  if (!archive || archive.version !== publication.packageVersion)
    throw new Error("publication archive identity mismatch");
  const primary = (archive.publicArtifacts?.artifacts || []).find(
    (entry) => entry.role === "primary",
  );
  if (!primary) throw new Error("publication archive has no primary artifact");
  const releasePassportPath = path.resolve(publication.passportPath);
  const releaseBase = `https://github.com/${publication.repository}/releases/download/${publication.releaseTag}`;
  const envelope = {
    repository: publication.repository,
    channel: publication.channel,
    tag: publication.releaseTag,
    tagTargetSha: publication.sourceSha,
    sourceSha: publication.sourceSha,
    package: {
      name: publication.packageName,
      version: publication.packageVersion,
      integrity: packageIntegrity,
      gitHead: packageFact.gitHead,
    },
    releasePassport: {
      url: `${releaseBase}/buildchain.release.json`,
      sha256: sha256File(releasePassportPath),
    },
    publicationArtifact: {
      id: archive.id,
      kind: manifest.publication.kind,
      version: archive.version,
      canonicalUrl: archive.routes.canonicalUrl,
      latestUrl: archive.routes.latestUrl,
      latestEvidenceUrl: archive.routes.latestEvidenceUrl || "",
      immutableVersionUrl:
        archive.routes.immutableVersionUrl ||
        archive.routes.immutableVersionPrefix,
      immutableVersionPrefix:
        archive.routes.immutableVersionPrefix ||
        archive.routes.immutableVersionUrl,
      registry: {
        url: `${releaseBase}/${path.basename(registryPath)}`,
        sha256: sha256File(registryPath),
      },
      manifest: {
        url: `${releaseBase}/${path.basename(manifestPath)}`,
        sha256: sha256File(manifestPath),
      },
      passport: {
        url: `${releaseBase}/${path.basename(passportPath)}`,
        sha256: sha256File(passportPath),
      },
      primaryArtifact: {
        path: primary.path,
        url: primary.url,
        sha256: primary.sha256,
        bytes: primary.bytes,
      },
      ...(archive.publicArtifacts.sourceBundle
        ? { sourceBundle: archive.publicArtifacts.sourceBundle }
        : {}),
    },
  };
  fs.writeFileSync(
    path.join(publication.workspace, ".buildchain/upstream-release.json"),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  return envelope;
}
