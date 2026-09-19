import fs from "node:fs";
import path from "node:path";
import artifact from "@actions/artifact";
import { recordDigest } from "../../release/discussion/envelope.js";
import {
  publicationPath,
  writeImmutablePublicationFile,
} from "../../publication/pipeline/files.js";
import { pipelineVersionRegenerationResult } from "../../publication/pipeline/version-regeneration.js";
import {
  pipelineVersionArtifactName,
  readPipelineVersionBuild,
} from "./pipeline-version-readback.js";

function verifyResult(context, result, platform) {
  const expected = pipelineVersionRegenerationResult(
    context.preparation,
    platform,
    result.files,
  );
  if (recordDigest(result) !== recordDigest(expected))
    throw new Error(
      "Version artifact changed its exact preparation, platform or bytes",
    );
  return result;
}

export function githubPipelineVersionArtifacts(host, client = artifact) {
  async function upload(context, result, directory) {
    verifyResult(context, result, result.platform);
    const file = writeImmutablePublicationFile(
      path.join(directory, "version.json"),
      JSON.stringify(result),
    );
    const uploaded = await client.uploadArtifact(
      pipelineVersionArtifactName(context, result.platform),
      [file],
      directory,
      {
        retentionDays: 30,
        compressionLevel: 0,
      },
    );
    if (!uploaded.id || !uploaded.digest)
      throw new Error("Version upload omitted immutable provider coordinates");
    return uploaded;
  }
  async function download(context, directory) {
    const { build, assets } = await readPipelineVersionBuild(context, host);
    const [repositoryOwner, repositoryName] = host.repository.split("/");
    const results = [];
    for (const [index, asset] of assets.entries()) {
      const target = path.join(directory, String(asset.id));
      fs.mkdirSync(target, { recursive: true });
      const downloaded = await client.downloadArtifact(asset.id, {
        path: target,
        expectedHash: asset.digest,
        findBy: {
          repositoryOwner,
          repositoryName,
          workflowRunId: context.runId,
          token: host.token,
        },
      });
      if (downloaded.digestMismatch)
        throw new Error(
          "Version download digest differs from its provider archive",
        );
      if (
        recordDigest(fs.readdirSync(target)) !== recordDigest(["version.json"])
      )
        throw new Error("Version artifact contains undeclared files");
      const file = publicationPath(target, "version.json");
      // JSON escaping can expand the bounded UTF-8 document inventory sixfold.
      if (fs.statSync(file).size > 384 * 1024 * 1024)
        throw new Error("Version artifact exceeds its encoded material limit");
      const bytes = fs.readFileSync(file);
      if (!Buffer.from(bytes.toString("utf8")).equals(bytes))
        throw new Error("Version artifact is not canonical UTF-8 text");
      results.push(
        verifyResult(
          context,
          JSON.parse(bytes.toString("utf8")),
          context.preparation.platforms[index],
        ),
      );
    }
    return { build, results };
  }
  return { upload, download };
}
