import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { lockedDependenciesAction } from "../../../../packages/core/runtime/locked-dependencies.js";

await runAction(lockedDependenciesAction);
