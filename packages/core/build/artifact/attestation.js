import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  artifactNames,
  verifyManifest,
  validateReference,
} from "./contracts.js";
import { readJson, rootOf, writeJson } from "../plan/values.js";
export function validateSigning(result, plan, platform) {
  const { root, ...body } = result;
  if (
    result.schema !== "buildchain.build-signing/v1" ||
    root !== rootOf(body) ||
    result.plan_root !== plan.root ||
    result.platform !== platform.id ||
    result.status !== "success" ||
    !result.controller?.qualifying
  )
    throw new Error("Invalid signing result");
  validateReference(result.payload, plan, artifactNames(plan, platform).final);
  return result;
}

export function createBuildAttestationService({
  plan,
  workspace,
  store,
  verifyAttestation,
}) {
  const { download, readRecord, upload } = store;
  async function loadFinalArtifact(platform, directory) {
    const result = validateSigning(
      await readRecord(
        plan,
        artifactNames(plan, platform).signing,
        path.join(workspace, `.buildchain/signed-records/${platform.id}`),
      ),
      plan,
      platform,
    );
    await download(result.payload, directory);
    const manifest = verifyManifest(
      path.join(
        directory,
        `.buildchain/artifacts/${platform.id}/manifest.json`,
      ),
      directory,
      plan,
      platform,
    );
    return { result, manifest };
  }
  async function prepareAttestation() {
    const declaration = plan.build.attestation;
    const platform = plan.platforms.find((p) => p.id === declaration.platform);
    if (!declaration.subject_path || !platform)
      throw new Error("Attestation is not declared");
    const directory = path.join(workspace, ".buildchain/attestation-input");
    const { result, manifest } = await loadFinalArtifact(platform, directory);
    const relative = path.posix.join(
      plan.project.cwd,
      declaration.subject_path,
    );
    if (!manifest.files.some((entry) => entry.path === relative))
      throw new Error("Attestation subject is absent from final manifest");
    const subject = path.resolve(directory, relative);
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(subject))
      .digest("hex");
    const predicate = {
      schema: "buildchain.build-attestation/v1",
      plan_root: plan.root,
      source: plan.source,
      runtime: plan.identity,
      platform: platform.id,
      artifact: result.payload,
      manifest_root: rootOf(manifest),
      signing_receipt_root: result.controller.digest,
    };
    writeJson(
      path.join(workspace, ".buildchain/attestation/predicate.json"),
      predicate,
    );
    writeJson(
      path.join(workspace, ".buildchain/attestation/preparation.json"),
      { platform, subject, digest, predicate },
    );
    return {
      subject,
      predicate: path.join(workspace, ".buildchain/attestation/predicate.json"),
    };
  }
  async function finalizeAttestation({ bundle, id, url }) {
    const prepared = readJson(
      path.join(workspace, ".buildchain/attestation/preparation.json"),
    );
    if (
      prepared.predicate?.plan_root !== plan.root ||
      prepared.platform?.id !== plan.build.attestation.platform
    )
      throw new Error("Attestation preparation belongs to another build");
    if (!id || !url) throw new Error("Attestation provider omitted identity");
    await verifyAttestation([
      "attestation",
      "verify",
      prepared.subject,
      "--repo",
      plan.run.repository,
      "--signer-workflow",
      "kungfu-systems/buildchain/.github/workflows/.build.yml",
      "--signer-digest",
      plan.identity.sha,
      "--source-digest",
      plan.source.sha,
      "--predicate-type",
      "https://buildchain.libkungfu.dev/attestations/build/v1",
      "--bundle",
      bundle,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ]);
    if (
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(prepared.subject))
        .digest("hex") !== prepared.digest
    )
      throw new Error("Attestation subject changed");
    fs.copyFileSync(
      bundle,
      path.join(workspace, ".buildchain/attestation/bundle.json"),
    );
    const evidence = {
      schema: "buildchain.build-attestation-evidence/v1",
      plan_root: plan.root,
      platform: prepared.platform.id,
      subject_digest: prepared.digest,
      id: id,
      url: url,
      bundle_digest: crypto
        .createHash("sha256")
        .update(fs.readFileSync(bundle))
        .digest("hex"),
      predicate_root: rootOf(prepared.predicate),
    };
    if (!evidence.id || !evidence.url)
      throw new Error("Attestation provider omitted identity");
    writeJson(path.join(workspace, ".buildchain/attestation/evidence.json"), {
      ...evidence,
      root: rootOf(evidence),
    });
    const ref = await upload(
      plan,
      artifactNames(plan, prepared.platform).attestation,
      ["."],
      path.join(workspace, ".buildchain/attestation"),
    );
    return ref;
  }

  return { loadFinalArtifact, prepareAttestation, finalizeAttestation };
}
