import fs from "node:fs";
import path from "node:path";
import { runLifecycle } from "./transaction.js";
import { lifecycleOptions } from "../plan/lifecycle.js";
import { assertStageOrder } from "../plan/stage-order.js";
import { commonEnv } from "../plan/environment.js";
import { readJson, writeJson } from "../plan/values.js";
import {
  executionResult,
  verifyExecutionIdentity,
} from "../artifact/contracts.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
import { createAnchoredVersionMaterialEvidence } from "../anchored-version-material.js";
import {
  prepareCompilerCacheEvidence,
  verifyCompilerCacheActivity,
} from "../cache/compiler-evidence.js";
import { sealSigning } from "../signing/prepare.js";
import { sealMacosCredentialInput } from "../credential/seal-input.js";
import { runTransportSmoke } from "../demo/transport-smoke.js";

export async function runBuildStage({
  plan,
  platform,
  stage,
  sourceRoot,
  environment,
  recovery,
}) {
  const file = path.join(
    sourceRoot,
    `.buildchain/execution/${platform.id}.json`,
  );
  const stages = fs.existsSync(file)
    ? verifyExecutionIdentity(readJson(file), plan, platform).stages
    : {};
  assertStageOrder(stages, stage);
  const cache = plan.environment.cache;
  const governed = {
    ...commonEnv(plan, platform),
    GITHUB_WORKSPACE: sourceRoot,
    BUILDCHAIN_COMPILER_CACHE_PROVIDER: cache.provider,
    BUILDCHAIN_COMPILER_CACHE_REQUIRED: cache.required,
    BUILDCHAIN_COMPILER_CACHE_PREPARATION_PATH:
      ".buildchain/diagnostics/compiler-cache-preparation.json",
    SHIFU_CACHE_PROFILE_REF: cache.profile_ref,
    SHIFU_CACHE_PROFILE_DIGEST: cache.profile_digest,
    CSC_IDENTITY_AUTO_DISCOVERY: plan.build.macos_signing.app_path
      ? "false"
      : "",
    CARGO_REGISTRIES_CRATES_IO_INDEX:
      plan.environment.tools.cargo_registry_index,
  };
  const session = consumerCommandSession({
    ...environment,
    ...Object.fromEntries(
      Object.entries(governed).map(([key, value]) => [key, String(value)]),
    ),
  });
  try {
    const restored = stage === "build" && recovery ? await recovery.restore() : null;
    if (stage === "install" && plan.anchored_material) {
      const evidence = await session.phase((env) =>
        createAnchoredVersionMaterialEvidence({
          cwd: path.join(sourceRoot, plan.project.cwd),
          targetChannel: plan.anchored_material.target_channel,
          targetRef: plan.anchored_material.target_ref,
          releaseRef: "HEAD",
          environment: env,
        }),
      );
      writeJson(
        path.join(
          sourceRoot,
          `.buildchain/artifacts/${platform.id}/anchored-version-material.json`,
        ),
        evidence,
      );
    }
    const usesCache =
      cache.provider !== "none" &&
      JSON.parse(cache.platforms_json).includes(platform.id);
    if (stage === "build" && usesCache && !restored)
      await session.phase((env) =>
        prepareCompilerCacheEvidence({ cwd: sourceRoot, env }),
      );
    if (!restored) await session.phase((env) =>
      runLifecycle({
        ...lifecycleOptions(plan, platform, stage, sourceRoot),
        env,
      }),
    );
    if (stage === "build") {
      if (usesCache && !restored)
        await session.phase((env) =>
          verifyCompilerCacheActivity({ cwd: sourceRoot, env }),
        );
      await sealSigning(plan, platform, sourceRoot);
      if (recovery) await recovery.retain();
    }
    if (
      stage === "verify" &&
      plan.build.macos_signing.app_path &&
      platform.id === plan.build.macos_signing.platform
    ) {
      sealMacosCredentialInput({
        workspace: sourceRoot,
        app: path.posix.join(
          plan.project.cwd,
          plan.build.macos_signing.app_path,
        ),
        outputRoot: `.buildchain/credential-island/${platform.id}`,
        repository: plan.run.repository,
        sourceSha: plan.source.sha,
        sourceTreeSha: plan.source.tree_sha,
        platformId: platform.id,
      });
    }
    if (
      stage === "verify" &&
      platform.id === "linux-x64" &&
      plan.build.transport_smoke.scenario_path
    ) {
      runTransportSmoke({
        artifactRoot: path.resolve(
          sourceRoot,
          plan.project.cwd,
          plan.build.transport_smoke.artifact_root,
        ),
        scenarioPath: path.resolve(
          sourceRoot,
          plan.project.cwd,
          plan.build.transport_smoke.scenario_path,
        ),
      });
    }
    stages[stage] = plan.lifecycle[stage].configured
      ? "success"
      : "not-required";
  } catch (error) {
    stages[stage] = "failure";
    throw error;
  } finally {
    writeJson(file, executionResult(plan, platform, stages));
  }
}
