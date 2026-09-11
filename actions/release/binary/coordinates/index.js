import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { resolveBinaryPublicationAction } from "../../../../packages/core/release/binary/coordinates-action.js";
await runAction(resolveBinaryPublicationAction);
