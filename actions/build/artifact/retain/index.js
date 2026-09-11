import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { retainBuildArtifactAction } from "../../../../packages/core/build/artifact/actions.js";
await runAction(retainBuildArtifactAction);
