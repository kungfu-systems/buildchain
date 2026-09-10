export function candidatePublicationOutputs(documents, settlement) {
  const outputs = {};
  outputs["release-invocation-path"] = documents.invocationPath;
  outputs["release-invocation-root"] =
    documents.releaseInvocation.roots.invocationRoot;
  outputs["release-transaction-path"] = documents.releaseTransactionPath;
  outputs["release-transaction-root"] =
    documents.releaseTransaction.transactionRoot;
  outputs["release-receipt-path"] = settlement.releaseReceiptPath;
  outputs["release-receipt-root"] = settlement.releaseReceipt.receiptRoot;
  outputs["product-provider-result-path"] = settlement.productProviderPath;
  outputs["product-provider-result-root"] =
    settlement.productProviderResult.root;
  outputs["release-passport-path"] = documents.passportPath;
  outputs["release-passport-root"] = documents.passport.passportRoot;
  outputs["transaction-state"] = settlement.result.transaction.state;
  outputs["declaration-root"] = settlement.result.declarationRoot;
  outputs["transaction-root"] = settlement.result.transaction.transactionRoot;
  outputs["state-root"] = settlement.result.transaction.stateRoot;
  outputs["receipt-roots-json"] = JSON.stringify(
    [
      settlement.productProviderResult.root,
      ...settlement.result.transaction.receipts.map(
        ({ receiptRoot }) => receiptRoot,
      ),
    ].sort(),
  );
  return outputs;
}
