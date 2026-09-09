import { runOperation } from "../../runtime/action-process.mjs";
import {
  writeAuthorityConfig,
  requireWriteAuthority,
  resolvePaperTarget,
} from "./publication-target.mjs";
import { verifyAdmittedCandidate } from "./admitted-candidate.mjs";
import { sealReleaseEnvelope } from "./release-envelope.mjs";
import { capturePaperPropagation } from "./capture-propagation.mjs";
await runOperation({
  "write-config": writeAuthorityConfig,
  "require-write": requireWriteAuthority,
  candidate: verifyAdmittedCandidate,
  target: resolvePaperTarget,
  envelope: sealReleaseEnvelope,
  capture: capturePaperPropagation,
});
