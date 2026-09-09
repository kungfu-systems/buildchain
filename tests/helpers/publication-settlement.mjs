// Synthetic current-contract evidence. No hosted run, signature, or publication is claimed.
import fs from "node:fs";
import {
  createReleaseInvocation,
  createDomainReleaseTransaction,
  createReleaseReceipt,
  RELEASE_RECEIPT_CONTRACT,
} from "../../packages/core/release/release-invocation.js";
import {
  createReleaseTailTransaction,
  executeReleaseTailTransaction,
  releaseTailRoot,
} from "../../packages/core/release/release-tail-provider-plane.js";
const root = (digit) => `sha256:${digit.repeat(64)}`;
async function completedTail(subject, transactionRoot) {
  const declaration = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../contracts/fixtures/release-tail-capabilities-v1/kungfu-alpha.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  declaration.subject = subject;
  const adapters = {};
  for (const capability of declaration.capabilities) {
    capability.operationIdentity.transactionRoot = transactionRoot;
    capability.operationIdentity.subjectRoot = releaseTailRoot(subject);
    capability.channelPolicy.channel = subject.channel;
    capability.channelPolicy.tagPattern = `^${subject.tag.replaceAll(".", "\\.")}$`;
    adapters[capability.adapter] = {
      apply: async () => {
        throw Error("Synthetic fixture must use memory readback only");
      },
      readback: async (effect) => ({
        outcome: "observed",
        subjectRoot: effect.subjectRoot,
        targetRoot: effect.targetRoot,
        evidenceRoots: [effect.targetRoot],
        providerCode: "synthetic-memory-readback",
      }),
    };
  }
  return executeReleaseTailTransaction(
    createReleaseTailTransaction(declaration),
    { adapters },
  );
}
export async function publicationSettlementFixture({ channel = "alpha" } = {}) {
  const repository = "kungfu-systems/buildchain",
    sourceSha = "d".repeat(40),
    tree = "e".repeat(40),
    runtimeSha = "f".repeat(40);
  const version = channel === "alpha" ? "4.1.0-alpha.0" : "4.1.0",
    tag = `v${version}`;
  const invocation = {
    schema: "kungfu-buildchain-v4-release-invocation/v1",
    publisher: {
      repository,
      workflow: ".github/workflows/.release-promote.yml",
      workflowSha: runtimeSha,
      job: "apply",
    },
    runtime: { repository, commit: runtimeSha, tree },
    candidate: { repository, commit: sourceSha, tree, version },
    target: { channel, tag, expectedOldSha: null },
    authority: {
      policyRoot: root("1"),
      qualificationRoot: root("2"),
      warrantRoot: root("3"),
    },
    provider: {
      adapter: "built-in-provider-plane",
      contract: "kungfu-buildchain-release-tail-provider/v1",
      repository,
    },
    parent: { invocationRoot: null, transactionRoot: null, receiptRoot: null },
  };
  const { roots } = createReleaseInvocation(invocation);
  const created = createDomainReleaseTransaction({
    invocationRoot: roots.invocationRoot,
    publisherRoot: roots.publisherRoot,
    runtimeRoot: roots.runtimeRoot,
    providerRoot: roots.providerRoot,
    parentRoot: roots.parentRoot,
  });
  const transaction = {
    ...created.transaction,
    transactionRoot: created.transactionRoot,
  };
  const subject = { repository, sourceSha, version, tag, channel };
  const providerState = await completedTail(
    subject,
    releaseTailRoot({ test: "provider", subject }),
  );
  const productState = await completedTail(
    subject,
    transaction.transactionRoot,
  );
  const passportBody = {
    schema: "kungfu.buildchain.release-passport/v4",
    repository,
    source: { headSha: sourceSha, treeHash: tree },
    release: { version, tag, channel },
    candidateRoot: roots.candidateRoot,
    policyDigest: invocation.authority.policyRoot,
    artifactRoot: root("4"),
    publicationQualificationRoot: invocation.authority.qualificationRoot,
    stageCapsuleAggregateRoot: root("5"),
    stageCapsuleRoots: [root("6")],
  };
  const passport = {
    ...passportBody,
    passportRoot: releaseTailRoot(passportBody),
  };
  const productBody = {
    schema: "kungfu.buildchain.v4-product-provider-result/v1",
    target: {
      ref: `${channel === "alpha" ? "alpha" : "release"}/v4/v4.1`,
      sha: sourceSha,
    },
    publication: {
      version,
      exactTag: tag,
      releaseSha: sourceSha,
      state: "complete",
      finalizationNeeded: false,
    },
    promotedSha: sourceSha,
    transaction: {
      transactionRoot: productState.transactionRoot,
      stateRoot: productState.stateRoot,
      planRoot: productState.planRoot,
      receiptRoots: productState.receipts.map((x) => x.receiptRoot),
      failure: null,
    },
    updates: [],
  };
  const product = { ...productBody, root: releaseTailRoot(productBody) };
  const terminal = createReleaseReceipt({
    schema: RELEASE_RECEIPT_CONTRACT,
    transactionRoot: transaction.transactionRoot,
    outcome: "complete",
    releasePassportRoot: passport.passportRoot,
    providerTransactionRoot: providerState.transactionRoot,
    providerStateRoot: providerState.stateRoot,
    providerReceiptRoots: [
      product.root,
      ...providerState.receipts.map((x) => x.receiptRoot),
    ].sort(),
  });
  return {
    schemaVersion: 1,
    contract: "buildchain-v4-publication-settlement/v1",
    id: "v4-publication",
    release: { sourceSha, tag, channel },
    documents: {
      invocation,
      transaction,
      receipt: { ...terminal.receipt, receiptRoot: terminal.receiptRoot },
      passport,
      product,
      providerState,
      productState,
    },
  };
}
