import fs from "node:fs";
import path from "node:path";
import {
  createReleaseCandidatePassport,
  validateReleaseCandidatePassport,
} from "../../release/release-candidate.js";
import { writeReleaseCandidateStageCapsules } from "./stage-capsules.js";

export function writeReleaseCandidatePassport({
  request,
  outputPath,
  coordinatesPath,
  workspace,
}) {
  const passport = createReleaseCandidatePassport(request);
  const validation = validateReleaseCandidatePassport({
    passport,
    repository: request.repository,
    sourceHeadSha: request.sourceHeadSha,
    buildSummary: request.buildSummary,
  });
  if (!validation.ok)
    throw new Error(
      `release candidate passport invalid: ${validation.errors.join("; ")}`,
    );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(passport, null, 2)}\n`);
  const stageCapsules = writeReleaseCandidateStageCapsules({
    passport,
    buildSummary: request.buildSummary,
    outputPath,
    coordinatesPath,
    workspace,
  });
  return { passport, stageCapsules };
}
