import fs from "node:fs";
import path from "node:path";
import { collectCandidateAdmissionEvidence } from "./candidate-evidence.js";
import { collectPaperAdmissionEvidence } from "./paper-evidence.js";
import { collectBinaryAdmissionEvidence } from "./binary-evidence.js";
import { sealManagedPublicationAdmission } from "./seal.js";
import { readGitHubSourceTree } from "../../providers/github/commits.js";
import { auditPublicationControlPlane } from "../../governance/publication/audit.js";
import { publicationControlPlaneRequest } from "./control-plane.js";
export async function assemblePublicationAdmission(
  { request, workspace, runtimeRoot, runner, token, governanceToken, apiUrl },
  { audit = auditPublicationControlPlane, tree = readGitHubSourceTree } = {},
) {

  const outputRoot = path.join(
      workspace,
      ".buildchain/publication-authority/auto",
    ),
    evidenceRoot = path.join(workspace, ".buildchain/publication-evidence");
  const controlPlaneAudit = audit(
    {
      ...publicationControlPlaneRequest(request),
      token: governanceToken,
      publicReadToken: token,
    },
    { outputPath: path.join(outputRoot, "control-plane.json") },
  );
  const registry = JSON.parse(
    fs.readFileSync(
      path.join(runtimeRoot, "dist/site/publication-authority-registry.json"),
      "utf8",
    ),
  );
  const collectors = {
    "release-candidate": collectCandidateAdmissionEvidence,
    "publication-artifact": collectPaperAdmissionEvidence,
    "binary-release-assets": collectBinaryAdmissionEvidence,
  };
  const collect = collectors[request.autoAdmissionKind];
  if (!collect) throw new Error("Unknown publication admission evidence kind");
  const sourceTreeSha =
    request.autoAdmissionKind === "binary-release-assets"
      ? undefined
      : await tree({
          repository: request.evidenceRepository,
          sourceSha: request.sourceSha,
          token,
          apiUrl,
        });
  const evidence = collect({
    evidenceRoot,
    registry,
    repository: request.evidenceRepository,
    sourceSha: request.sourceSha,
    sourceTreeSha,
    runtimeSha: request.runtimeSha,
    publicationVersion: request.publicationVersion,
  });
  const bundle = sealManagedPublicationAdmission({
    request,
    evidence,
    registry,
    controlPlaneAudit,
    runner,
  });
  for (const [key, value] of Object.entries(bundle))
    fs.writeFileSync(
      path.join(outputRoot, `${key}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  return bundle;
}
