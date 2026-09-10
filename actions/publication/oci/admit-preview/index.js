import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitComposePreviewAction } from "../../../../packages/core/publication/oci/preview-actions.js";
await runAction(admitComposePreviewAction);
