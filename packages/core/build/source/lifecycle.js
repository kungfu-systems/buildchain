import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadBuildchainConfig,
  validateBuildchainConfig,
} from "../../consumer/buildchain-config.js";
import { collectPaperSourcePolicy } from "../../paper/paper.js";
import { runLifecycle } from "../lifecycle/transaction.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";

export function admitSourcePaper(
  { cwd, runtimeRoot, runtimeRef },
  inspect = collectPaperSourcePolicy,
) {
  const config = loadBuildchainConfig(cwd)?.config;
  const applicable =
    fs.existsSync(path.join(cwd, ".buildchain/paper")) ||
    config?.publish?.kind === "npm-paper-package" ||
    (config?.project?.type === "publication-artifact" &&
      (!config.publication || config.publication.kind === "paper"));
  if (!applicable) return { applicable: false };
  const result = inspect({ cwd });
  console.log(JSON.stringify(result));
  if (!result.ok)
    throw new Error("Paper agent-entry and acceptance policy did not qualify");
  return result;
}

export async function qualifySourceLifecycle(
  {
    workspace,
    cwd,
    runtimeRoot,
    runtimeRef,
    mode,
    requireVersionState = false,
    env,
    paperAdmission = true,
    evidencePrefix = "check",
  },
  {
    admitPaper = admitSourcePaper,
    validate = validateBuildchainConfig,
    lifecycle = runLifecycle,
    observe = () => {},
  } = {},
) {
  if (!["source", "verify"].includes(mode))
    throw new Error(`Unsupported check mode: ${mode}`);
  const stage = mode === "source" ? "check" : "verify";
  const state = {
    stage,
    paper: "skipped",
    validate: "skipped",
    install: "skipped",
    check: "skipped",
  };
  const session = consumerCommandSession(env);
  const journal = path.join(
    workspace,
    `.buildchain/diagnostics/${evidencePrefix}-transaction.json`,
  );
  const persist = () => {
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, JSON.stringify(state, null, 2) + "\n");
    observe({ ...state });
  };
  const phase = async (name, effect) => {
    state[name] = "running";
    persist();
    try {
      const result = await effect();
      state[name] = "success";
      return result;
    } catch (error) {
      state[name] = "failure";
      state.failure = {
        phase: name,
        message: error.message,
        status: error.status || 1,
      };
      throw error;
    } finally {
      persist();
    }
  };
  persist();
  if (paperAdmission)
    await phase("paper", () => admitPaper({ cwd, runtimeRoot, runtimeRef }));
  await phase("validate", () =>
    validate(cwd, {
      requireVersionState,
      requireLifecycleStages: ["install", stage],
    }),
  );
  for (const [name, stageName, suffix] of [
    ["install", "install", "-install"],
    ["check", stage, ""],
  ]) {
    await phase(name, () =>
      session.phase((phaseEnv) =>
        lifecycle({
          cwd,
          workspace,
          stageName,
          required: true,
          artifactName: `buildchain-${evidencePrefix}${suffix}`,
          manifestPath: `.buildchain/artifacts/${evidencePrefix}${suffix}-manifest.json`,
          summaryPath: `.buildchain/artifacts/${evidencePrefix}${suffix}-summary.json`,
          artifactPaths: [],
          expectedArtifactsJson: "",
          platformId: os.platform(),
          platformName: os.platform(),
          logPath:
            phaseEnv.BUILDCHAIN_LOG_PATH || ".buildchain/logs/events.jsonl",
          processSummaryPath: "",
          env: phaseEnv,
        }),
      ),
    );
  }
  return state;
}
