import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { binaryPublicationDispatchAction } from "../../../../packages/core/build/binary-publication-dispatch.js";

await runAction(binaryPublicationDispatchAction);
