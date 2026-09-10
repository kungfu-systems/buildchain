import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { captureDemoCollectionAction } from "../../../../packages/core/build/demo/collection-actions.js";
await runAction(captureDemoCollectionAction);
