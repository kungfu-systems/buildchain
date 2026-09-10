import {
  required,
  safeSigningId,
  signingFilesNamed,
  signingFileDigest,
  resolveSigningPath,
  writeSigningResultIndex,
} from "./files.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateArtifactSigningRequest } from "../artifact-signing.js";

export function materializeArtifactSigningRequest({
  requestRoot,
  requestPath,
  expectedProfile,
  outputPath,
} = {}) {
  const root = path.resolve(required(requestRoot, "signing request root"));
  const requestFile = resolveSigningPath(root, requestPath, "request path");
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  const check = validateArtifactSigningRequest(request);
  if (!check.ok)
    throw new Error(
      `invalid artifact signing request: ${check.issues.join(", ")}`,
    );
  if (expectedProfile && request.signature.profile !== expectedProfile)
    throw new Error("artifact signing profile mismatch");
  if (request.artifact.transport?.format !== "exact-file")
    throw new Error("native executable signing requires exact-file transport");
  const requestIndexRoot = path.dirname(path.dirname(requestFile));
  const payload = resolveSigningPath(
    requestIndexRoot,
    request.artifact.transport.file,
    "transport payload",
  );
  const stat = fs.statSync(payload);
  const payloadDigest = signingFileDigest(payload);
  if (
    !stat.isFile() ||
    stat.size !== request.artifact.transport.bytes ||
    stat.size !== request.artifact.bytes ||
    payloadDigest !== request.artifact.transport.digest ||
    payloadDigest !== request.artifact.digest
  ) {
    throw new Error("signing payload does not match its sealed request");
  }
  const output = path.resolve(required(outputPath, "unsigned output path"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(payload, output, fs.constants.COPYFILE_EXCL);
  return { request, output };
}
