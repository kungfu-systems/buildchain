import fs from "node:fs";
import path from "node:path";
import {
  artifactNames,
  verifyCredential,
  validateReference,
} from "../artifact/contracts.js";
import { readJson, rootOf, writeJson } from "../plan/values.js";
export async function collectFinalPayloads(
  { workspace, file, readRecord, loadFinalArtifact, download },
  plan,
) {
  const payloads = [];
  let anchored;
  for (const platform of plan.platforms) {
    const names = artifactNames(plan, platform);
    const directory = path.join(
      workspace,
      `.buildchain/final-artifacts/${platform.id}`,
    );
    const { result, manifest } = await loadFinalArtifact(platform, directory);
    const material = readJson(
      path.join(
        directory,
        `.buildchain/artifacts/${platform.id}/anchored-version-material.json`,
      ),
    );
    if (anchored && rootOf(anchored) !== rootOf(material))
      throw new Error("Platform anchored version material differs");
    anchored = material;
    payloads.push(result.payload);
    writeJson(
      file(`.buildchain/downloaded-manifests/${platform.id}/manifest.json`),
      manifest,
    );
    const diagnostics = path.join(
      directory,
      `.buildchain/artifacts/${platform.id}/diagnostics.json`,
    );
    if (!fs.existsSync(diagnostics))
      throw new Error(`Missing diagnostics for ${platform.id}`);
    writeJson(
      file(
        `.buildchain/downloaded-diagnostics/${platform.id}/diagnostics.json`,
      ),
      readJson(diagnostics),
    );
  }
  let credential;
  if (plan.build.macos_signing.app_path) {
    const platform = plan.platforms.find(
      (p) => p.id === plan.build.macos_signing.platform,
    );
    credential = await readRecord(
      plan,
      `${artifactNames(plan, platform).signing}-credential`,
      file(".buildchain/credential-record"),
    );
    const { root, ...body } = credential;
    if (
      credential.plan_root !== plan.root ||
      root !== rootOf(body) ||
      credential.status !== "success"
    )
      throw new Error("Invalid credential result");
    const payloadRoot = file(".buildchain/credential-payload");
    await download(validateReference(credential.payload, plan), payloadRoot);
    await download(
      validateReference(credential.manifest, plan),
      file(".buildchain/downloaded-manifests/credential"),
    );
    verifyCredential(
      file(".buildchain/downloaded-manifests/credential/manifest.json"),
      payloadRoot,
      plan,
      platform,
    );
  }
  return { payloads, anchored, credential };
}
