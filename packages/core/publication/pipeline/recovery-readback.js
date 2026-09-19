import { recordDigest } from "../../release/discussion/envelope.js";

export async function observeRecoveryPublicationEffects({
  effects,
  receipts,
  retained,
  provider,
  fence,
}) {
  const transactionRoot = retained.documents.transaction.transactionRoot;
  const observations = [];
  for (const effect of effects) {
    const { root, ...body } = effect;
    if (root !== recordDigest(body))
      throw new Error(
        "Recovery publication effect changed its immutable declaration",
      );
    const prior = receipts.filter((receipt) => receipt.effectId === effect.id);
    for (const receipt of prior) {
      const { root: receiptRoot, ...value } = receipt;
      if (
        receiptRoot !== recordDigest(value) ||
        value.schema !== "buildchain.pipeline-publication-effect/v1" ||
        receipt.transactionRoot !== transactionRoot ||
        receipt.effectRoot !== effect.root
      )
        throw new Error(
          "Recovery cannot rewrite a prior publication receipt or transaction",
        );
    }
    await fence();
    const observed = await provider.observe(effect);
    const matched = provider.matches(effect, observed);
    if (
      (!matched && prior.some((item) => item.state === "success")) ||
      (observed.state !== "absent" &&
        !matched &&
        !provider.canApply?.(effect, observed))
    )
      throw new Error(
        "Recovery publication destination conflicts with retained bytes",
      );
    observations.push({ effect, observed, matched });
  }
  const body = {
    schema: "buildchain.pipeline-recovery-publication-readback/v1",
    transactionRoot,
    qualificationRoot: retained.qualified.root,
    signingRoot: recordDigest(retained.signing),
    sealedRoot: retained.sealed.root,
    effectsRoot: recordDigest(effects),
    receiptRoots: receipts.map((receipt) => receipt.root),
    observations,
  };
  return { ...body, root: recordDigest(body) };
}
