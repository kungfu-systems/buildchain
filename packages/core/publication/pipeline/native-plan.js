export function pipelineNativeSigning(contract) {
  const rules = contract.products
    .flatMap((product) =>
      product.platforms.flatMap((platform) =>
        (product.signing || []).map((rule) => ({
          ...rule,
          id: `${product.id}-${platform}-${rule.artifact}`,
          product: product.id,
          platform,
          directory: product.directory || ".",
        })),
      ),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    rules.length > 32 ||
    new Set(rules.map((rule) => rule.id)).size !== rules.length
  )
    throw new Error(
      "Native signing requires a bounded unique request inventory",
    );
  return rules;
}
