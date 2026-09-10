import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { applyComposePreviewAction } from "../../../../packages/core/publication/oci/preview-actions.js";
await runAction(applyComposePreviewAction);
