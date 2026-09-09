import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runOperation } from "../../runtime/action-process.mjs";
export async function verify(env) {
  const { readApplyDocuments, verifyPublicationSettlement } = await import(
    pathToFileURL(
      path.resolve(
        ".buildchain/runtime/packages/core/publication/commands/publication-settlement.mjs",
      ),
    ).href
  );
  const documents = readApplyDocuments(".buildchain/evidence");
  verifyPublicationSettlement(documents, {
    repository: env.GITHUB_REPOSITORY,
    candidateSha: env.CANDIDATE_SHA,
    tag: documents.invocation.target.tag,
    sourceSha: documents.product.publication.releaseSha,
  });
  const storedReceipt = documents.receipt;
  const receiptRoot = storedReceipt.receiptRoot;
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `receipt-json=${JSON.stringify(storedReceipt)}\nreceipt-root=${receiptRoot}\nstatus=complete\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({ verify });
