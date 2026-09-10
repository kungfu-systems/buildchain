import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { aggregateStageCapsuleConsumerAction } from "../../../../packages/core/build/stage-capsule/actions.js";
await runAction(aggregateStageCapsuleConsumerAction);
