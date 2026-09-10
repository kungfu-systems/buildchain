import fs from "node:fs";
import path from "node:path";
import { context, getOctokit } from "@actions/github";
import { resolveArtifactCoordinate } from "./artifact-coordinate.js";
import { requireValue } from "../runtime/action-process.mjs";

export async function artifactCoordinateAction(core, env) {
  const relative = core.getInput("output", { required: true });
  const workspace = fs.realpathSync(env.GITHUB_WORKSPACE);
  const target = path.resolve(workspace, relative);
  const relation = path.relative(workspace, target);
  requireValue(
    relation &&
      relation !== ".." &&
      !relation.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relation),
    "Artifact coordinate output escapes its workspace",
  );
  const result = await resolveArtifactCoordinate(
    {
      name: core.getInput("name", { required: true }),
      digest: core.getInput("digest", { required: true }),
      sourceSha: core.getInput("source-sha", { required: true }),
      runAttempt: env.GITHUB_RUN_ATTEMPT,
    },
    { context, github: getOctokit(core.getInput("token", { required: true })) },
  );
  let parent = workspace;
  for (const component of path
    .dirname(relation)
    .split(path.sep)
    .filter((value) => value !== ".")) {
    parent = path.join(parent, component);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent);
    const stat = fs.lstatSync(parent);
    requireValue(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Artifact coordinate output crosses a symlink boundary",
    );
  }
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  core.setOutput("artifact-id", result.id);
  core.setOutput("coordinate", JSON.stringify(result));
}
