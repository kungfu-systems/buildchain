import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { renderQualifiedDemoAction } from "../../../../packages/core/build/demo/adapter-actions.js";
await runAction(renderQualifiedDemoAction);
