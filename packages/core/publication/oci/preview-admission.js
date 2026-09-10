import fs from "node:fs";
import path from "node:path";
import { verifyPublicationSettlement } from "../settlement/transaction.js";
import {
  verifyComposePublication,
  verifyComposeQualification,
} from "../oci-compose-qualification.js";
import { check, read } from "./preview-values.js";
export async function admitComposePreview(
  { repository, eventName, event, workspace },
  provider,
) {
  check(
    eventName === "workflow_run" && event.workflow_run?.id,
    "requires a completed qualification workflow event",
  );
  check(
    /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository),
    "invalid repository",
  );
  const id = String(event.workflow_run.id);
  check(/^\d+$/u.test(id), "invalid qualification run");
  const run = await provider.json(`repos/${repository}/actions/runs/${id}`),
    tag = run.head_branch;
  check(
    /^v\d+\.\d+\.\d+-alpha\.\d+$/u.test(tag),
    "qualification must run on an exact alpha tag",
  );
  const release = await provider.json(
    `repos/${repository}/releases/tags/${tag}`,
  );
  check(release.prerelease && !release.draft, "public alpha release required");
  const root = path.resolve(workspace, ".buildchain/compose-preview");
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  const names = [
    "oci-family.json",
    "oci-publication-readback.json",
    "buildchain-publication-settlement.json",
    "buildchain.release.json",
  ];
  for (const name of names) {
    check(
      release.assets.filter((asset) => asset.name === name).length === 1,
      `missing exact public asset ${name}`,
    );
    const asset = release.assets.find((asset) => asset.name === name);
    fs.writeFileSync(
      path.join(root, "public", name),
      await provider.assetBytes(asset),
    );
  }
  const [family, readback, settlement, publicPassport] = names.map((name) =>
    read(path.join(root, "public", name)),
  );
  const documents = settlement.documents;
  const tagged = (await provider.json(`repos/${repository}/commits/${tag}`))
    .sha;
  verifyPublicationSettlement(documents, {
    repository,
    tag,
    sourceSha: tagged,
    publicPassport,
  });
  const context = verifyComposePublication({
    family,
    readback,
    documents,
    repository,
    tag,
  });
  verifyComposeQualification(context, run);
  const artifactName = `oci-compose-qualification-${id}-${run.run_attempt}`;
  const artifacts = (
    await provider.json(
      `repos/${repository}/actions/runs/${id}/artifacts?per_page=100`,
    )
  ).artifacts.filter(
    (artifact) => artifact.name === artifactName && !artifact.expired,
  );
  check(
    artifacts.length === 1,
    "qualification artifact is missing or ambiguous",
  );
  return {
    root,
    context,
    run,
    release,
    artifactId: String(artifacts[0].id),
    runId: id,
    sourceSha: tagged,
  };
}
