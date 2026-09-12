import { recordDigest } from "../../release/discussion/envelope.js";

const KINDS = new Set([
  "exact-tag",
  "npm-package",
  "release-asset",
  "release-visibility",
  "npm-channel",
  "git-channel",
]);

export function pipelinePublicationEffects({
  plan,
  qualified,
  documents,
  evidence = [],
}) {
  const effects = [
    {
      id: "exact-tag",
      kind: "exact-tag",
      tag: plan.tag,
      commit: qualified.source.commit,
    },
  ];
  for (const artifact of qualified.artifacts) {
    for (const target of artifact.targets) {
      if (target.provider === "npm")
        effects.push({
          id: `npm:${artifact.id}`,
          kind: "npm-package",
          product: artifact.id,
          name: artifact.package.name,
          version: artifact.package.version,
          integrity: artifact.package.integrity,
          access: target.access || "public",
          tag: `buildchain-${plan.root.slice(7, 23)}`,
        });
      if (target.provider === "github-release")
        effects.push({
          id: `asset:${artifact.id}`,
          kind: "release-asset",
          product: artifact.id,
          tag: plan.tag,
          name: artifact.file.split("/").at(-1),
          digest: artifact.digest,
          size: artifact.size,
        });
    }
  }
  for (const asset of evidence)
    effects.push({
      id: `evidence:${asset.id}`,
      kind: "release-asset",
      product: `evidence:${asset.id}`,
      tag: plan.tag,
      name: asset.name,
      digest: asset.digest,
      size: asset.size,
    });
  effects.push({
    id: "release-passport",
    kind: "release-asset",
    product: "release-passport",
    tag: plan.tag,
    name: "buildchain.release.json",
    documentRoot: documents.passport.passportRoot,
  });
  effects.push({
    id: "release-visibility",
    kind: "release-visibility",
    tag: plan.tag,
    prerelease: plan.channel === "alpha",
  });
  return effects.map((effect) => ({ ...effect, root: recordDigest(effect) }));
}

// This executor owns only bounded provider operations. Journal admission/fencing
// and provider implementations are required dependencies, never consumer hooks.
// Each irreversible success is retained before a later operation is attempted.
export async function applyPipelineEffects({
  effects,
  transactionRoot,
  receipts,
  provider,
  fence,
  retain,
}) {
  const results = [];
  for (const effect of effects) {
    const { root, ...body } = effect;
    if (!KINDS.has(effect.kind) || root !== recordDigest(body))
      throw new Error("Unrecognized or modified publication effect");
    await fence();
    const prior = receipts.filter((receipt) => receipt.effectId === effect.id);
    if (
      prior.some(
        (receipt) =>
          receipt.effectRoot !== root ||
          receipt.transactionRoot !== transactionRoot,
      )
    )
      throw new Error(
        "Publication effect conflicts with immutable prior intent",
      );
    const completed = prior.find((receipt) => receipt.state === "success");
    let observed = await provider.observe(effect);
    if (completed) {
      if (!provider.matches(effect, observed))
        throw new Error(
          "A completed publication no longer matches provider bytes",
        );
      results.push(completed);
      continue;
    }
    if (
      observed.state !== "absent" &&
      !provider.matches(effect, observed) &&
      !provider.canApply?.(effect, observed)
    )
      throw new Error(
        "Publication destination already contains conflicting bytes",
      );
    if (!prior.length)
      await retain(rootedReceipt(effect, transactionRoot, "pending", observed));
    if (!provider.matches(effect, observed)) {
      await fence();
      // Preserve unknown outcomes. A lost response is reconciled from provider
      // state before any retry; absence still propagates the original failure.
      let failure;
      try {
        await provider.apply(effect);
      } catch (error) {
        failure = error;
      }
      observed = await provider.observe(effect);
      if (!provider.matches(effect, observed)) {
        if (failure) throw failure;
        throw new Error(
          "Publication write lacks exact successful provider readback",
        );
      }
    }
    await fence();
    const receipt = rootedReceipt(effect, transactionRoot, "success", observed);
    await retain(receipt);
    results.push(receipt);
  }
  return results;
}

function rootedReceipt(effect, transactionRoot, state, observed) {
  const body = {
    schema: "buildchain.pipeline-publication-effect/v1",
    effectId: effect.id,
    effectRoot: effect.root,
    transactionRoot,
    state,
    observed,
  };
  return { ...body, root: recordDigest(body) };
}
