import path from "node:path";
import { runBuildStage } from "../../packages/core/build/lifecycle/stage.js";
const plan = JSON.parse(process.env.BUILDCHAIN_PLAN);
const selected = JSON.parse(process.env.BUILDCHAIN_PLATFORM);
await runBuildStage({
  plan,
  platform: plan.platforms.find((platform) => platform.id === selected.id),
  sourceRoot: path.join(process.env.GITHUB_WORKSPACE, "source"),
  stage: process.env.BUILDCHAIN_STAGE,
  environment: process.env,
});
