import path from "node:path";
import fs from "node:fs";
import { installationRoot } from "../../runtime/installation-root.js";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";
import { releaseAssetClient } from "../../providers/github/release-assets.js";
import {
  settlePublication,
  readApplyDocuments,
  verifyPublicationSettlement,
} from "./transaction.js";
function input(core, env) {
  const runtimeRoot = installationRoot(import.meta.url),
    workspace = path.resolve(env.GITHUB_WORKSPACE);
  if (
    fs.realpathSync(runtimeRoot) !==
    fs.realpathSync(path.join(workspace, ".buildchain/runtime"))
  )
    throw new Error("Settlement must execute the admitted runtime");
  verifyCheckoutIdentity({
    directory: runtimeRoot,
    sha: core.getInput("runtime-sha", { required: true }),
    label: "Publication settlement runtime",
  });
  return {
    repository: env.GITHUB_REPOSITORY,
    candidateSha: core.getInput("candidate-sha", { required: true }),
    workspace,
  };
}
function emit(core, receipt) {
  core.setOutput("receipt-json", JSON.stringify(receipt));
  core.setOutput("receipt-root", receipt.receiptRoot);
  core.setOutput("status", "complete");
}
export async function retainPublicationSettlementAction(core, env) {
  const { workspace, ...identity } = input(core, env);
  const result = await settlePublication({
    ...identity,
    base: path.join(workspace, ".buildchain"),
    client: releaseAssetClient(identity.repository, {
      token: core.getInput("token", { required: true }),
    }),
    applyOutcome: core.getInput("apply-outcome", { required: true }),
  });
  emit(core, result.receipt);
  await core.summary
    .addRaw(
      `Publication: **complete**, receipt \`${result.receipt.receiptRoot}\`. Next development: **${result.summary.nextDevelopment}**. Binary distribution: **pending provider readback**.\n`,
    )
    .write();
}
export function verifyPublicationSettlementAction(core, env) {
  const { workspace, ...identity } = input(core, env),
    documents = readApplyDocuments(
      path.join(workspace, ".buildchain/evidence"),
    );
  verifyPublicationSettlement(documents, {
    ...identity,
    tag: documents.invocation.target.tag,
    sourceSha: documents.product.publication.releaseSha,
  });
  emit(core, documents.receipt);
}
