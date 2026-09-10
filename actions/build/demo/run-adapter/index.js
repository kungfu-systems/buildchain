import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyDemoAdapterAction } from "../../../../packages/core/build/demo/adapter-actions.js";
await runAction(qualifyDemoAdapterAction);
