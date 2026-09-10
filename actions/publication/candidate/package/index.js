import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { packageCandidateArtifactAction } from "../../../../packages/core/publication/candidate/package.js";
await runAction(packageCandidateArtifactAction);
