import path from "node:path";
import { command } from "../../../runtime/action-process.mjs";
import { rehearseStageCheckpoint } from "./run.js";
import { rehearseStageResume } from "./resume.js";
import { rehearseTailResealMacos } from "./macos-tail.js";
export function verifyStageCapsuleCheckpoints({
  runtimeRoot,
  workspace,
  platform,
  environment,
}) {
  // The source qualification exercises the actual committed WASM and its failure tests.
  command(
    process.execPath,
    ["--test", path.join(runtimeRoot, "tests/domain-wasm.test.mjs")],
    { cwd: runtimeRoot, env: environment },
  );
  const workRoot = path.join(workspace, ".buildchain/stage-checkpoint");
  const checkpoint = rehearseStageCheckpoint({
    runtimeRoot,
    workRoot,
    platformId: platform,
    stageId: "build",
    recordedAt: "2026-08-08T00:00:00.000Z",
  });
  const resume = rehearseStageResume({ runtimeRoot, platform });
  const tail =
    platform === "macos-arm64"
      ? rehearseTailResealMacos({
          fixturePath: path.join(
            runtimeRoot,
            "contracts/fixtures/v4-tail-reseal-v1/valid.json",
          ),
          outputPath: path.join(workRoot, "tail-reseal-macos.json"),
        })
      : null;
  return { checkpoint, resume, tail };
}
export function verifyStageCapsuleCheckpointsAction(core, env) {
  const sourceRoot = path.resolve(env.GITHUB_WORKSPACE);
  if (
    command("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
      stdio: "pipe",
    }).trim() !== env.GITHUB_SHA
  )
    throw new Error(
      "Checkpoint verification must execute exact candidate source",
    );
  return verifyStageCapsuleCheckpoints({
    runtimeRoot: sourceRoot,
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    platform: core.getInput("platform", { required: true }),
    environment: env,
  });
}
