export const RELEASE_TAIL_PRODUCT_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: "product.version-state.materialize",
    executor: "provider-adapter",
    adapter: "github-version-state",
    effectKind: "product-version-state-materialization",
    observationKind: "product-version-state-readback",
    receiptKind: "product-version-state",
    transactionState: "preparing",
  }),
  Object.freeze({
    id: "product.package.publish",
    executor: "provider-adapter",
    adapter: "npm-trusted-publishing",
    effectKind: "product-package-publication",
    observationKind: "product-package-readback",
    receiptKind: "product-package-publication",
    transactionState: "publishing",
  }),
  Object.freeze({
    id: "product.release-refs.converge",
    executor: "provider-adapter",
    adapter: "github-release-refs",
    effectKind: "product-release-ref-convergence",
    observationKind: "product-release-ref-readback",
    receiptKind: "product-release-ref-convergence",
    transactionState: "committing",
  }),
]);
