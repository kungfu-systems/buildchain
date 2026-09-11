import fs from "node:fs";
import { buildStageRecovery } from "../../packages/core/build/recovery/transaction.js";
import path from "node:path";
import { runBuildStage } from "../../packages/core/build/lifecycle/stage.js";
const plan = JSON.parse(process.env.BUILDCHAIN_PLAN);
const selected = JSON.parse(process.env.BUILDCHAIN_PLATFORM);
const sourceRoot = path.join(process.env.GITHUB_WORKSPACE, "source");
const platform = plan.platforms.find((p) => p.id === selected.id);
const recovery = process.env.BUILDCHAIN_TEST_RETAINED ? buildStageRecovery({plan,platform,sourceRoot,workspace:process.env.GITHUB_WORKSPACE}, "test", {
  lookup: async (_plan,name,options) => { if(options.runId !== plan.recovery.runId) throw Error("Wrong producer"); return {name}; },
  download: async (_ref,destination) => fs.cpSync(process.env.BUILDCHAIN_TEST_RETAINED,destination,{recursive:true}),
  upload: async (_plan,_name,files) => { if (!files.length) throw Error("Missing checkpoint"); },
}) : undefined;
await runBuildStage({
  recovery,
  plan,
  platform: plan.platforms.find((platform) => platform.id === selected.id),
  sourceRoot: path.join(process.env.GITHUB_WORKSPACE, "source"),
  stage: process.env.BUILDCHAIN_STAGE,
  environment: process.env,
});
