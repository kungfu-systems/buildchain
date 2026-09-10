import {
  isPromotionRouting,
  releasePassportCertificationVerificationOptions,
} from "../../consumer/floating-consumer-release-passport.js";
import { verifyFloatingConsumerPolicyCertification } from "../../consumer/floating-consumer-evidence.js";
import { issue } from "./issues.js";
import {
  verifyRuntimeAuthorizationReceipt,
  verifyRuntimeResumeLineage,
} from "../../consumer/runtime-ref-resume-authority.js";
import { runtimeResumeSourceSha } from "./consumer-input.js";
export function validateConsumerPolicyPassportSection({ passport, issues }) {
  const routing = passport?.promotionRouting;
  const evidence = passport?.v4ConsumerPolicy;
  if (isPromotionRouting(routing) && !evidence) {
    issues.push(
      issue(
        "error",
        "v4ConsumerPolicy.missing",
        "Buildchain v4 Release Passport requires an external floating consumer policy certification",
      ),
    );
    return;
  }
  if (!evidence) return;
  const verification = verifyFloatingConsumerPolicyCertification(
    releasePassportCertificationVerificationOptions({
      evidence,
      passport,
      routing,
    }),
  );
  for (const failure of verification.failures) {
    issues.push(
      issue("error", `v4ConsumerPolicy.${failure.code}`, failure.message),
    );
  }
}
export function validateRuntimeResumePassportSection({ passport, issues }) {
  const evidence = passport?.v4RuntimeResume;
  if (!evidence) return;
  const consumerPolicyReceiptRoot =
    passport?.v4ConsumerPolicy?.certification?.receiptRoot || "";
  const authorization = verifyRuntimeAuthorizationReceipt({
    receipt: evidence.authorization,
    receiptRoot: evidence.authorizationRoot,
    repository: passport?.product?.repository || "",
    sourceSha: runtimeResumeSourceSha(
      passport?.release,
      passport?.release?.sourceSha || "",
    ),
    runtimeSha: passport?.promotionRouting?.runtime?.resolvedSha || "",
    consumerPolicyReceiptRoot,
  });
  for (const failure of authorization.failures) {
    issues.push(
      issue("error", `v4RuntimeResume.authorization.${failure}`, failure),
    );
  }
  const lineage = verifyRuntimeResumeLineage({
    lineage: evidence.lineage,
    lineageRoot: evidence.lineageRoot,
    repository: passport?.product?.repository || "",
    sourceSha: runtimeResumeSourceSha(
      passport?.release,
      passport?.release?.sourceSha || "",
    ),
    resumeRuntimeSha: passport?.promotionRouting?.runtime?.resolvedSha || "",
    consumerPolicyReceiptRoot,
  });
  for (const failure of lineage.failures) {
    issues.push(issue("error", `v4RuntimeResume.lineage.${failure}`, failure));
  }
  if (evidence.lineage?.authorizationRoot !== evidence.authorizationRoot) {
    issues.push(
      issue(
        "error",
        "v4RuntimeResume.authorization-root-mismatch",
        "runtime resume lineage must bind the embedded authorization receipt root",
      ),
    );
  }
}
