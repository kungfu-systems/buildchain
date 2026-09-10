import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { publishBinaryAssetsAction } from "../../../../packages/core/publication/binary/action.js";
await runAction(publishBinaryAssetsAction);
