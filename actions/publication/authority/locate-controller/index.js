import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { locateAuthorityControllerAction } from "../../../../packages/core/publication/authority/actions.js";
await runAction(locateAuthorityControllerAction);
