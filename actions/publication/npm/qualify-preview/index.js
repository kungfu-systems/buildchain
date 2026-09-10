import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { previewNpmPublicationAction } from "../../../../packages/core/publication/npm/preview-action.js";
await runAction(previewNpmPublicationAction);
