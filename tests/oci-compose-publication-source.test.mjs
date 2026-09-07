import assert from "node:assert/strict";
import test from "node:test";
import { verifyComposePublication } from "../packages/core/oci-compose-qualification.js";
import { domainContentRoot } from "../packages/core/canonical-contracts.js";
import { releaseTailRoot } from "../packages/core/release-tail-provider-plane.js";

function fixture(merged) {
  const repository = "example/runtime",
    tag = "v1.0.0-alpha.2";
  const built = "a".repeat(40),
    published = merged ? "b".repeat(40) : built;
  const tree = "c".repeat(40),
    digest = "sha256:" + "d".repeat(64);
  const image = {
    name: "hub",
    kind: "image",
    repository: `ghcr.io/${repository}/hub`,
    digest,
  };
  const application = {
    name: "hub-compose",
    kind: "compose",
    targetImage: "hub",
    repository: image.repository,
    digest,
    preview: {
      alias: "compose-preview",
      previousDigest: "none",
      qualificationWorkflow: ".github/workflows/qualify.yml",
    },
  };
  const body = {
    schema: "kungfu-buildchain-oci-family/v2",
    repository,
    version: tag.slice(1),
    sourceSha: built,
    images: [image, application],
  };
  const family = {
    ...body,
    root: domainContentRoot("oci-publication-family", body),
  };
  const readback = {
    familyRoot: family.root,
    version: body.version,
    sourceSha: published,
    candidateSourceSha: built,
    images: [image, application].map((entry) => ({
      ...entry,
      ref: entry.kind === "compose" ? `compose-${tag}` : tag,
      anonymous: true,
    })),
  };
  const documents = {
    invocation: { candidate: { commit: published, tree } },
    passport: {
      source: {
        headSha: published,
        builtSourceSha: built,
        builtSourceTreeSha: tree,
      },
    },
    product: { publication: { releaseSha: published } },
    productState: {
      operations: [
        {
          capabilityId: "product.oci.publish",
          receipt: { evidenceRoots: [releaseTailRoot(readback)] },
        },
      ],
    },
    receipt: { receiptRoot: "sha256:" + "e".repeat(64) },
  };
  return { family, readback, documents, repository, tag };
}

for (const merged of [false, true])
  test(`Compose binds verified built source with ${merged ? "merge-equivalent" : "exact"} publication`, () => {
    const input = fixture(merged);
    const context = verifyComposePublication(input);
    assert.equal(
      context.sourceSha,
      input.documents.invocation.candidate.commit,
    );
    assert.equal(context.familyRoot, input.family.root);
  });

test("Compose rejects mismatched built source, tree and protected registry readback", () => {
  const wrong = "f".repeat(40);
  for (const change of [
    (input) => {
      input.documents.passport.source.builtSourceSha = wrong;
    },
    (input) => {
      input.documents.passport.source.builtSourceTreeSha = wrong;
    },
    (input) => {
      input.readback.sourceSha = wrong;
    },
    (input) => {
      input.readback.candidateSourceSha = wrong;
    },
    (input) => {
      delete input.documents.passport.source.builtSourceSha;
    },
    (input) => {
      delete input.documents.passport.source.builtSourceTreeSha;
    },
  ]) {
    const input = fixture(true);
    change(input);
    // Isolate identity checks from the already verified settlement's receipt binding.
    input.documents.productState.operations[0].receipt.evidenceRoots = [
      releaseTailRoot(input.readback),
    ];
    assert.throws(
      () => verifyComposePublication(input),
      /unbound public OCI family/u,
    );
  }
});
