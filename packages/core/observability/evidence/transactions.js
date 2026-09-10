import fs from "node:fs";
import path from "node:path";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
import { transactionJournal } from "../transaction-journal.js";
import { publishObservedEvidence } from "./publication.js";

function publicationOptions(request, workspace) {
  return {
    manifestPath: path.resolve(workspace, request["manifest-path"]),
    artifactRoot: path.resolve(workspace, request["artifact-path"]),
    bucket: request["production-bucket"],
    distributionId: request["cloudfront-distribution"],
  };
}
export async function qualifyObservedEvidence(
  { request, workspace, environment, token },
  ports = {},
) {
  const session = consumerCommandSession(environment);
  const journal = transactionJournal(
    path.join(workspace, ".buildchain/observed-evidence/execution.json"),
    ["build", "verify", "admit"],
  );
  await journal.observe("build", () =>
    session.run(
      {
        script: request["build-command"],
        cwd: workspace,
        pipefail: true,
        env: { GH_TOKEN: token },
      },
      ports.execute,
    ),
  );
  await journal.observe("verify", () =>
    session.run(
      { script: request["verify-command"], cwd: workspace, pipefail: true },
      ports.execute,
    ),
  );
  return journal.observe("admit", () =>
    (ports.publish || publishObservedEvidence)({
      ...publicationOptions(request, workspace),
      dryRun: true,
    }),
  );
}
export function publishQualifiedEvidence({ request, workspace }, ports = {}) {
  // Revalidate source bytes after credentials are configured and immediately
  // before the immutable/projection/latest publication transaction.
  const result = (ports.publish || publishObservedEvidence)({
    ...publicationOptions(request, workspace),
    dryRun: false,
  });
  const receiptPath = path.join(
    workspace,
    ".buildchain/observed-evidence/receipt.json",
  );
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(result, null, 2) + "\n");
  return { result, receiptPath };
}
