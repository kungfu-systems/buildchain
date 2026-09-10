import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { verifyStageCapsuleCheckpointsAction } from "../../../../packages/core/build/stage-capsule/rehearsal/verify.js";
await runAction(verifyStageCapsuleCheckpointsAction);
