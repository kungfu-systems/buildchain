import { releaseTailRoot } from "../../release/release-tail-provider-plane.js";
import { ociPublicationTag } from "../oci-publication-graph.js";
import { check } from "./preview-values.js";
export async function promoteComposePreview({
  context,
  registry,
  receipt,
  fetchManifest,
}) {
  const { application, policy } = context;
  const exact = await fetchManifest(
    ociPublicationTag(application, context.tag.slice(1)),
  );
  check(
    exact.digest === application.digest,
    "immutable application digest changed",
  );
  const current = await fetchManifest(policy.alias, true);
  check(
    current.digest === policy.previousDigest ||
      current.digest === application.digest,
    "preview changed since qualification",
  );
  const plan = {
    schema: "kungfu-buildchain-compose-preview-plan/v1",
    ...context,
    qualificationRoot: releaseTailRoot(receipt),
    expectedOld: policy.previousDigest,
    targetDigest: application.digest,
    operation: "digest-preserving-preview-promotion",
  };
  if (current.digest !== application.digest) {
    const result = await registry(application, `manifests/${policy.alias}`, {
      write: true,
      method: "PUT",
      body: exact.bytes,
      headers: {
        "content-type": exact.mediaType,
        "content-length": String(exact.bytes.length),
      },
    });
    check(
      result.status === 201,
      `preview write uncertain (HTTP ${result.status}); retain the original qualification for readback`,
    );
  }
  const observed = await fetchManifest(policy.alias);
  check(observed.digest === application.digest, "preview readback mismatch");
  const body = {
    schema: "kungfu-buildchain-compose-preview-receipt/v1",
    repository: context.repository,
    tag: context.tag,
    sourceSha: context.sourceSha,
    publicationReceiptRoot: context.publicationReceiptRoot,
    planRoot: releaseTailRoot(plan),
    qualificationRoot: plan.qualificationRoot,
    previousDigest: policy.previousDigest,
    application: `${application.repository}@${application.digest}`,
    alias: `${application.repository}:${policy.alias}`,
    observedDigest: observed.digest,
    outcome: "complete",
  };
  return { ...body, receiptRoot: releaseTailRoot(body) };
}
