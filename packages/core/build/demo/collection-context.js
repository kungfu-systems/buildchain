import fs from "node:fs";
import path from "node:path";
import { validateScenario } from "./scenario.js";
import { requireValue } from "../../runtime/action-process.mjs";
export function demoScenario({ workspace, scenarioPath: relativePath }) {
  const repository = path.join(workspace, "source");
  const scenarioPath = path.resolve(repository, relativePath);
  const relative = path.relative(repository, scenarioPath);
  requireValue(
    relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative),
    "Demo scenario must belong to the checked-out source",
  );
  requireValue(
    fs
      .realpathSync(scenarioPath)
      .startsWith(fs.realpathSync(repository) + path.sep),
    "Demo scenario resolves outside checked-out source",
  );
  return {
    repository,
    scenarioPath,
    scenario: validateScenario(
      JSON.parse(fs.readFileSync(scenarioPath, "utf8")),
    ),
  };
}
export function demoCollectionIdentity({ sourceSha, run }, kind) {
  requireValue(
    /^[0-9a-f]{40}$/u.test(sourceSha || ""),
    "Demo source SHA must be exact",
  );
  requireValue(
    ["captures", "evidence"].includes(kind),
    "Unknown demo collection kind",
  );
  return `declarative-demo-${kind}-${sourceSha.slice(0, 12)}-${run.id}-${run.attempt}`;
}
