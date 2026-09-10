import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { exposeUserToolchainAction } from "../../../../packages/core/runtime/toolchain/user-paths.js";
await runAction(exposeUserToolchainAction);
