import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { prepareWindowsRustAction } from "../../../../packages/core/runtime/toolchain/actions.js";
await runAction(prepareWindowsRustAction);
