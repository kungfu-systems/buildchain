import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitProviderFinalizerAction } from "../../../../packages/core/dev-delivery/native/actions.js";
await runAction(admitProviderFinalizerAction);
