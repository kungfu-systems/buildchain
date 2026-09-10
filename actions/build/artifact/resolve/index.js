import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { artifactCoordinateAction } from "../../../../packages/core/build/artifact-coordinate-action.js";

await runAction(artifactCoordinateAction);
