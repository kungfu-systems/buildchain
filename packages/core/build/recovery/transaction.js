import path from "node:path";
import { createBuildArtifactStore } from "../artifact/store.js";
import {
  checkpointName,
  sealBuildCheckpoint,
  restoreBuildCheckpoint,
} from "./checkpoint.js";

export function buildStageRecovery(
  context,
  token,
  store = createBuildArtifactStore({ token }),
) {
  const { plan, platform, sourceRoot, workspace } = context;
  return {
    async restore() {
      if (!plan.recovery) return null;
      const retainedRoot = path.join(
        workspace,
        `.buildchain/recovery-input/${platform.id}`,
      );
      const name = checkpointName(platform);
      let ref;
      try {
        ref = await store.lookup(plan, name, { runId: plan.recovery.runId });
      } catch (error) {
        // Only a proven absent checkpoint permits rebuilding. Provider errors,
        // duplicates and digest failures remain errors with the original signal.
        if (error.code === "artifact-not-found") return null;
        throw error;
      }
      await store.download(ref, retainedRoot);
      return restoreBuildCheckpoint({
        plan,
        platform,
        sourceRoot,
        retainedRoot,
      });
    },
    async retain() {
      const sealed = sealBuildCheckpoint({ plan, platform, sourceRoot });
      if (!sealed) return null;
      return store.upload(
        plan,
        checkpointName(platform),
        sealed.paths,
        sourceRoot,
      );
    },
  };
}
