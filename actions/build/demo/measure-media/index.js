import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { mediaQualificationAction } from "../../../../packages/core/build/demo/media-qualification-action.js";

await runAction(mediaQualificationAction);
