import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compileReleaseTailDeclaration,
  createReleaseTailTransaction,
  executeReleaseTailTransaction,
  readReleaseTailTransaction,
  releaseTailRoot,
  writeReleaseTailTransaction,
} from "../release-tail-provider-plane.js";
import {
  createProductPublicationDeclaration,
  selectProductPublicationIntent,
} from "../product-publication.js";
import {
  createProductPublicationAdapters,
  localVersionFiles,
} from "./product-provider-adapters.js";

export { advanceAlphaNextDevelopment, advanceStableNextDevelopment } from "./next-development-provider.js";

const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

export function activateExactPnpm({ temporaryRoot = os.tmpdir() } = {}) {
  const shimDirectory = fs.mkdtempSync(path.join(temporaryRoot, "buildchain-pnpm-"));
  const shimPath = path.join(shimDirectory, "pnpm");
  fs.writeFileSync(shimPath, '#!/bin/sh\nexec corepack pnpm@11.7.0 "$@"\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(shimDirectory, "pnpm.cmd"),
    "@echo off\r\ncorepack pnpm@11.7.0 %*\r\n",
  );
  process.env.PATH = `${shimDirectory}${path.delimiter}${process.env.PATH || ""}`;
  return shimPath;
}

export function selectProductPublicationPlan(
  result,
  { fallbackVersion = "", fallbackTag = "", fallbackCandidateVersion = "" } = {},
) {
  const planned = result?.updates?.find(({ action }) => action === "dry-run-publish-transaction");
  const version = String(planned?.version || fallbackVersion || "").trim();
  const tag = String(planned?.publicTag || planned?.tag || fallbackTag || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error("product publication planning did not produce an exact version");
  if (tag !== `v${version}`)
    throw new Error("product publication planning produced a mismatched exact tag");
  const plannedCandidateVersion = String(planned?.releaseCandidateVersion || "").trim();
  const sealedVersion = String(fallbackCandidateVersion || "").trim();
  if (plannedCandidateVersion && sealedVersion && plannedCandidateVersion !== sealedVersion)
    throw new Error("product publication planning drifted from the sealed candidate version");
  return {
    version,
    tag,
    candidateVersion: plannedCandidateVersion || sealedVersion,
  };
}

export function sealedCandidateVersion(request) {
  if (request.publicationIntent?.artifactKind === "custom") {
    const version = String(request.candidate?.target?.version || "").trim();
    if (!version) throw new Error("sealed candidate passport omitted the exact version");
    return version;
  }
  const manifest = read(request.sealedBundleManifest);
  if (request.publicationIntent?.artifactKind === "oci") {
    const version = String(manifest.version || "").trim();
    if (!version || version !== request.candidate?.target?.version)
      throw new Error("sealed OCI family version differs from candidate passport");
    return version;
  }
  const name = String(manifest?.npm?.name || "").trim();
  const version = String(manifest?.npm?.version || "").trim();
  if (name !== request.publishPackageMain || !version)
    throw new Error("sealed candidate manifest omitted the exact main package version");
  return version;
}

function providerProjection({ transaction, targetRef, targetSha, intent, releaseSha, promotedSha, updates }) {
  const projection = {
    schema: "kungfu.buildchain.v4-product-provider-result/v1",
    target: { ref: targetRef, sha: targetSha },
    publication: {
      version: intent.version,
      exactTag: intent.exactTag,
      releaseSha: String(releaseSha || ""),
      state: transaction.state,
      finalizationNeeded: transaction.state !== "complete",
    },
    promotedSha: String(promotedSha || ""),
    transaction: {
      transactionRoot: transaction.transactionRoot,
      stateRoot: transaction.stateRoot,
      planRoot: transaction.planRoot,
      receiptRoots: transaction.receipts.map(({ receiptRoot }) => receiptRoot).sort(),
      failure: transaction.failure,
    },
    updates: (updates || []).map((entry) => Object.fromEntries(
      ["action", "ref", "tag", "sha", "version"].map((key) => [key, String(entry[key] || "")]),
    )),
  };
  return { ...projection, root: releaseTailRoot(projection) };
}

export async function planProductPublication(
  request,
  { fallbackVersion = "", fallbackTag = "" } = {},
) {
  const supplied = request.publicationIntent;
  if (!supplied) throw new Error("rooted product publication intent is required");
  const candidateVersion = sealedCandidateVersion(request);
  if (candidateVersion !== supplied.candidateVersion)
    throw new Error("rooted product publication intent drifted from the sealed candidate version");
  const intent = selectProductPublicationIntent({
    ...supplied,
    recoveredVersion: supplied.mode === "resume" ? supplied.version : "",
  });
  if (intent.intentRoot !== supplied.intentRoot)
    throw new Error("product publication intent root mismatch");
  if (intent.version !== fallbackVersion || intent.exactTag !== fallbackTag)
    throw new Error("QUALIFY product publication intent drifted before APPLY");
  return {
    version: intent.version,
    tag: intent.exactTag,
    candidateVersion,
    intentRoot: intent.intentRoot,
  };
}

export async function applyProductPublication(request, plan) {
  const declaration = createProductPublicationDeclaration({
    intent: request.publicationIntent,
    plan,
  });
  const effectPlan = compileReleaseTailDeclaration(declaration);
  const statePath = path.resolve(".buildchain/release-tail/product-provider-transaction.json");
  let transaction = fs.existsSync(statePath)
    ? readReleaseTailTransaction(statePath)
    : createReleaseTailTransaction(effectPlan);
  if (
    transaction.transactionRoot !== plan.transactionRoot ||
    transaction.planRoot !== effectPlan.planRoot
  )
    throw new Error("retained product transaction drifted from the rooted plan");
  if (
    !["preparing", "prepared", "publishing", "committing", "reading-back"].includes(
      transaction.state,
    ) &&
    transaction.state !== "complete"
  )
    transaction = createReleaseTailTransaction(effectPlan);
  const runtime = createProductPublicationAdapters({
    request,
    intent: request.publicationIntent,
    plan,
  });
  transaction = await executeReleaseTailTransaction(transaction, {
    adapters: runtime.adapters,
    checkpoint: async (next) => {
      writeReleaseTailTransaction(statePath, next);
      if (request.discussionCheckpoint) await request.discussionCheckpoint("publication", next);
    },
  });
  writeReleaseTailTransaction(statePath, transaction);
  const releaseSha = await runtime.resolveReleaseSha();
  const projection = providerProjection({
    transaction,
    targetRef: request.targetRef,
    targetSha: request.targetSha,
    intent: request.publicationIntent,
    releaseSha,
    promotedSha: await runtime.resolvePromotedSha(),
    updates: runtime.updates,
  });
  if (projection.publication.state !== "complete" || projection.publication.finalizationNeeded)
    throw Object.assign(
      new Error(
        `product provider stopped in ${projection.publication.state || "unknown"}: finalization-needed=${projection.publication.finalizationNeeded}`,
      ),
      {
        code: projection.transaction.failure?.code || "product-publication-finalization-needed",
        providerProjection: projection,
      },
    );
  if (![projection.publication.releaseSha, projection.promotedSha].every((sha) => /^[0-9a-f]{40}$/u.test(sha)))
    throw new Error("product provider result omitted the exact release or promotion SHA");
  return projection;
}
