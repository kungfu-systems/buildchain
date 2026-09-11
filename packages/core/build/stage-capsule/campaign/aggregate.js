import fs from "node:fs";
import path from "node:path";
import {
  qualifyStageCapsuleCampaign,
  reconcileStageCapsuleWave,
} from "../../stage-capsule-qualification.js";
import { readJson, writeJson } from "./context.js";
function reportFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "report.json")
        files.push(target);
    }
  };
  visit(directory);
  return files.sort();
}

export function aggregateStageCapsuleCampaign({
  directory,
  expectedConsumers,
  output,
}) {
  const reports = reportFiles(directory)
    .map(readJson)
    .sort((left, right) =>
      `${left.consumer}/${left.platform}`.localeCompare(
        `${right.consumer}/${right.platform}`,
        "en",
      ),
    );
  const qualification = qualifyStageCapsuleCampaign(reports, expectedConsumers);
  if (output) writeJson(path.resolve(output), qualification);
  return qualification;
}
export function reconcileStageCapsuleCampaign({
  qualificationPath,
  evidencePath,
  output,
}) {
  const qualification = readJson(qualificationPath);
  const request = readJson(evidencePath);
  if (request.qualificationRoot !== qualification.qualificationRoot)
    throw new Error("wave evidence does not bind the qualification root");
  const reconciliation = reconcileStageCapsuleWave(request);
  if (output) writeJson(path.resolve(output), reconciliation);
  return reconciliation;
}
