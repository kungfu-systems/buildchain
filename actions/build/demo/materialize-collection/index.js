import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { publishDemoCollectionAction } from "../../../../packages/core/build/demo/collection-actions.js";
await runAction(publishDemoCollectionAction);
