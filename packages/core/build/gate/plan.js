import path from "node:path";
import { resolveRunnerMatrix } from "../runner/matrix.js";
import {
  createGateExecutionMatrix,
  normalizeGatePlatform,
} from "./contracts.js";
import { commandForPlatform, parseJson, writeJson } from "./files.js";
import { runGateCommand, gateArgs } from "./commands.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
export async function planGateProfiles(
  {
    profile,
    includeAdvisory = false,
    commandJson,
    registry,
    cwd,
    outputRoot,
    environment,
    runnerPreset = "github-hosted",
    platformsJson = "",
  },
  execute = runGateCommand,
) {
  const session = consumerCommandSession(environment);
  const resolvedRunners = resolveRunnerMatrix({ runnerPreset, platformsJson });
  const platforms = resolvedRunners.platforms.map(normalizeGatePlatform);
  const plans = {};
  for (const platform of platforms) {
    const argv = commandForPlatform(
      commandJson,
      process.platform === "win32" ? "windows" : "linux",
    );
    const args = gateArgs(
      [
        "gate",
        "plan",
        profile,
        "--platform",
        platform.platform,
        ...(includeAdvisory ? ["--include-advisory"] : []),
        "--json",
      ],
      registry,
    );
    const result = await session.phase((env) =>
      execute(argv, args, { cwd, env }),
    );
    const plan = parseJson(result.stdout, `Shifu gate plan for ${platform.id}`);
    plans[platform.id] = plan;
    writeJson(path.join(outputRoot, "plans", `${platform.id}.json`), plan);
  }
  const matrix = createGateExecutionMatrix({
    profile,
    includeAdvisory,
    platforms,
    plans,
  });
  const matrixPath = path.join(outputRoot, "matrix.json");
  writeJson(matrixPath, matrix);
  return matrix;
}
