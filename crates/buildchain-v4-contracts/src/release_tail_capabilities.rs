#[derive(Clone, Copy)]
pub(super) struct Descriptor {
    pub(super) id: &'static str,
    pub(super) executor: &'static str,
    pub(super) adapter: &'static str,
    pub(super) effect_kind: &'static str,
    pub(super) observation_kind: &'static str,
    pub(super) receipt_kind: &'static str,
    pub(super) transaction_state: &'static str,
}

pub(super) const DESCRIPTORS: &[Descriptor] = &[
    Descriptor {
        id: "product.version-state.materialize",
        executor: "provider-adapter",
        adapter: "github-version-state",
        effect_kind: "product-version-state-materialization",
        observation_kind: "product-version-state-readback",
        receipt_kind: "product-version-state",
        transaction_state: "preparing",
    },
    Descriptor {
        id: "product.package.publish",
        executor: "provider-adapter",
        adapter: "npm-trusted-publishing",
        effect_kind: "product-package-publication",
        observation_kind: "product-package-readback",
        receipt_kind: "product-package-publication",
        transaction_state: "publishing",
    },
    Descriptor {
        id: "product.oci.publish",
        executor: "provider-adapter",
        adapter: "oci-image-family",
        effect_kind: "oci-family-publication",
        observation_kind: "oci-family-readback",
        receipt_kind: "oci-family-publication",
        transaction_state: "publishing",
    },
    Descriptor {
        id: "product.release-refs.converge",
        executor: "provider-adapter",
        adapter: "github-release-refs",
        effect_kind: "product-release-ref-convergence",
        observation_kind: "product-release-ref-readback",
        receipt_kind: "product-release-ref-convergence",
        transaction_state: "committing",
    },
    Descriptor {
        id: "artifact.publish",
        executor: "provider-adapter",
        adapter: "github-release-assets",
        effect_kind: "artifact-publication",
        observation_kind: "artifact-publication-readback",
        receipt_kind: "artifact-publication",
        transaction_state: "publishing",
    },
    Descriptor {
        id: "signed-channel.commit",
        executor: "provider-adapter",
        adapter: "signed-static-channel",
        effect_kind: "signed-channel-commit",
        observation_kind: "signed-channel-readback",
        receipt_kind: "publication-commit",
        transaction_state: "committing",
    },
    Descriptor {
        id: "release.activate",
        executor: "provider-adapter",
        adapter: "site-release-activation",
        effect_kind: "release-activation",
        observation_kind: "production-readback",
        receipt_kind: "activation-receipt-set",
        transaction_state: "activating",
    },
    Descriptor {
        id: "released-evidence.synthesize",
        executor: "buildchain-core",
        adapter: "activation-receipt-projector",
        effect_kind: "released-evidence-projection",
        observation_kind: "released-evidence-validation",
        receipt_kind: "released-evidence",
        transaction_state: "settling",
    },
];

pub(super) fn descriptor(id: &str) -> Option<Descriptor> {
    DESCRIPTORS.iter().copied().find(|entry| entry.id == id)
}
