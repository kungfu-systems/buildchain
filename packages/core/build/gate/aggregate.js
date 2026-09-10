import { createGateAggregate } from "./contracts.js";
import { readJson, writeJson, findNamedFiles } from "./files.js";
export function aggregateGateProfiles({
  matrixPath,
  inputRoot,
  outputPath,
  sourceSha,
}) {
  const matrix = readJson(matrixPath, "gate matrix");
  const executions = new Map();
  for (const file of findNamedFiles(inputRoot, "execution.json")) {
    const execution = readJson(file, "gate execution");
    if (!execution.platformId) throw new Error(`${file} is missing platformId`);
    if (executions.has(execution.platformId))
      throw new Error(`duplicate gate execution for ${execution.platformId}`);
    executions.set(execution.platformId, execution);
  }
  const aggregate = createGateAggregate({ matrix, sourceSha, executions });
  writeJson(outputPath, aggregate);
  return aggregate;
}
