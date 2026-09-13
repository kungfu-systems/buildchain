import { recordDigest } from "../../release/discussion/envelope.js";
import {
  createReleaseInvocation,
  createReleaseReceipt,
  RELEASE_RECEIPT_CONTRACT,
} from "../../release/release-invocation.js";
import {
  createDomainPublicationQualificationReceipt,
  validatePublicationQualificationReceipt,
} from "../publication-qualification.js";
import { verifyPipelineQualification } from "./documents.js";

export const RECOVERY_PUBLICATION_ADMISSION =
  "buildchain.pipeline-recovery-publication-admission/v1";

// Only the publisher's byte/signature/provider requalification calls this pure
// domain bridge. It creates fresh authority for the new execution and preserves
// the original invocation, transaction, Passport and qualification unchanged.
export function createRecoveryPublicationAdmission({
  context,
  retained,
  execution,
  readback,
  now = new Date(),
}) {
  const { plan, materialization } = context;
  const { qualified, documents } = retained;
  const { root, ...body } = readback;
  if (
    !context.recovery ||
    !/^sha256:[0-9a-f]{64}$/u.test(context.recovery.planRoot || "") ||
    context.recovery.predecessor === context.attempt ||
    execution.attempt !== context.attempt ||
    execution.runId !== context.runId ||
    execution.runAttempt !== context.runAttempt ||
    body.schema !== "buildchain.pipeline-recovery-publication-readback/v1" ||
    root !== recordDigest(body) ||
    body.transactionRoot !== documents.transaction.transactionRoot ||
    body.qualificationRoot !== qualified.root ||
    body.signingRoot !== recordDigest(retained.signing) ||
    body.sealedRoot !== retained.sealed.root
  )
    throw new Error(
      "Recovery publication admission requires exact current execution and independent retained-byte readback",
    );
  verifyPipelineQualification({
    plan,
    materialization,
    qualified,
    evaluatedAt: qualified.qualification.issuedAt,
  });
  const qualification = createDomainPublicationQualificationReceipt({
    ...qualified.qualification,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
  });
  // This observation reports the predecessor transaction at the recovery
  // boundary. It is not a replacement for any original terminal receipt.
  const predecessorReceipt = createReleaseReceipt({
    schema: RELEASE_RECEIPT_CONTRACT,
    transactionRoot: documents.transaction.transactionRoot,
    outcome: "blocked",
    releasePassportRoot: documents.passport.passportRoot,
    providerTransactionRoot: body.effectsRoot,
    providerStateRoot: readback.root,
    providerReceiptRoots: [...new Set(body.receiptRoots)].sort(),
  });
  const invocation = createReleaseInvocation({
    ...documents.invocation.invocation,
    publisher: execution.publisher,
    runtime: execution.runtime,
    authority: {
      policyRoot: plan.contractRoot,
      qualificationRoot: qualification.receiptRoot,
      warrantRoot: qualification.receiptRoot,
    },
    parent: {
      invocationRoot: documents.invocation.roots.invocationRoot,
      transactionRoot: documents.transaction.transactionRoot,
      receiptRoot: predecessorReceipt.receiptRoot,
    },
  });
  const value = {
    schema: RECOVERY_PUBLICATION_ADMISSION,
    contextRoot: recordDigest(context),
    recoveryPlanRoot: context.recovery.planRoot,
    execution,
    originalDocumentsRoot: recordDigest(documents),
    readbackRoot: readback.root,
    qualification,
    predecessorReceipt,
    invocation,
  };
  return { ...value, root: recordDigest(value) };
}

export function verifyRecoveryPublicationAdmission(
  admission,
  { context, retained, execution, readback, now = new Date() },
) {
  const expected = createRecoveryPublicationAdmission({
    context,
    retained,
    execution,
    readback,
    now: new Date(admission.qualification.issuedAt),
  });
  if (recordDigest(expected) !== recordDigest(admission))
    throw new Error(
      "Recovery publication authority changed its exact execution or original transaction",
    );
  validatePublicationQualificationReceipt(admission.qualification, {
    repository: context.plan.source.repository,
    candidateRoot: retained.qualified.qualification.candidateRoot,
    sourceSha: retained.qualified.source.commit,
    sourceRoot: recordDigest(retained.qualified.source),
    artifactRoot: retained.qualified.qualification.artifactRoot,
    policyDigest: context.plan.contractRoot,
    evaluatedAt: now.toISOString(),
  });
  return admission;
}
