import fs from "node:fs";
import path from "node:path";
import {
  createReleaseInvocation,
  createDomainReleaseTransaction,
  createReleaseReceipt,
} from "../../release/release-invocation.js";
import { fail } from "./identity.js";
export function verifiedReleaseDocuments() {
  const base = path.resolve(".buildchain/release-tail");
  const invocation = JSON.parse(
    fs.readFileSync(path.join(base, "release-invocation.json")),
  );
  const transaction = JSON.parse(
    fs.readFileSync(path.join(base, "release-transaction.json")),
  );
  const storedReceipt = JSON.parse(
    fs.readFileSync(path.join(base, "release-receipt.json")),
  );
  const invocationProjection = createReleaseInvocation(invocation);
  const transactionProjection = createDomainReleaseTransaction({
    invocationRoot: transaction.invocationRoot,
    publisherRoot: transaction.publisherRoot,
    runtimeRoot: transaction.runtimeRoot,
    providerRoot: transaction.providerRoot,
    parentRoot: transaction.parentRoot,
  });
  const { receiptRoot, ...receipt } = storedReceipt;
  const receiptProjection = createReleaseReceipt(receipt);
  if (
    transaction.invocationRoot !== invocationProjection.roots.invocationRoot ||
    transaction.transactionRoot !== transactionProjection.transactionRoot ||
    receipt.transactionRoot !== transactionProjection.transactionRoot ||
    receiptProjection.receiptRoot !== receiptRoot ||
    receipt.outcome !== "complete"
  )
    fail("terminal ReleaseReceipt lineage does not verify");
  return { invocation, transaction, receipt: storedReceipt };
}
