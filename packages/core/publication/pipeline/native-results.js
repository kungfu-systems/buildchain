import fs from "node:fs";
import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import { verifyArtifactSigningResults } from "../../build/signing/verify-results.js";
import { acceptedMacosCredentialEvidence } from "../../build/macos-credential-island/dmg-assembly.js";
import { verifyMacosCredentialPayloads } from "../../build/macos-credential-island/payload-evidence.js";
import { publicationFile, publicationPath } from "./files.js";

const read = (root, file) =>
  JSON.parse(fs.readFileSync(publicationPath(root, file), "utf8"));

function archiveEvidence(evidence, request) {
  const checks = [
    "codesign-strict",
    "developer-id-team",
    "hardened-runtime",
    "secure-timestamp",
    "compound-archive-safe-paths",
    "embedded-wheel-record-integrity",
    "notarytool-accepted",
    "compound-notary-ticket-online",
  ];
  const profile = request.signature.entitlementsProfile || "none";
  if (profile !== "none") checks.push("jit-executable-entitlement");
  if (
    evidence.contract !== "kungfu-buildchain-apple-developer-id-evidence/v1" ||
    evidence.status !== "passed" ||
    evidence.provider !== "apple" ||
    evidence.artifactKind !== "archive" ||
    evidence.notarization?.status !== "Accepted" ||
    !evidence.notarization.id ||
    evidence.compound?.entitlementsProfile !== profile ||
    recordDigest(evidence.compound?.entitledPaths) !==
      recordDigest([...(request.signature.entitlementsPaths || [])].sort()) ||
    !Array.isArray(evidence.checks) ||
    checks.some((check) => !evidence.checks.includes(check))
  )
    throw new Error(
      "Native archive evidence does not satisfy the declared signing profile",
    );
}

function appPayloads(directory, evidence, request, result, authority) {
  if (
    !acceptedMacosCredentialEvidence(evidence, request, {
      runId: String(authority.runId),
      runAttempt: String(authority.runAttempt),
    })
  )
    throw new Error(
      "Native app evidence differs from the admitted authority execution",
    );
  const credentialRoot = publicationPath(
    directory,
    "credential-artifact",
    "directory",
  );
  const manifest = read(credentialRoot, "manifest.json");
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    new Set(manifest.files.map((file) => file.path)).size !==
      manifest.files.length
  )
    throw new Error("Native credential artifact has an invalid file inventory");
  for (const file of manifest.files) {
    const observed = publicationFile(
      publicationPath(credentialRoot, file.path),
    );
    if (
      observed.size !== file.size ||
      observed.digest !== `sha256:${file.sha256}`
    )
      throw new Error("Native credential artifact changed after signing");
  }
  verifyMacosCredentialPayloads({
    evidenceDocument: evidence,
    manifest,
    payloadPath: publicationPath(directory, result.artifact.path),
  });
  return evidence.artifacts.map((payload) => {
    const file = manifest.files.find(
      (item) => path.posix.basename(item.path) === payload.name,
    );
    return {
      kind: payload.kind,
      path: publicationPath(credentialRoot, file.path),
      size: payload.bytes,
      digest: payload.sha256,
    };
  });
}

function resultFiles(root, entry) {
  const resultPath = publicationPath(root, entry.result);
  const directory = path.dirname(resultPath);
  const result = read(directory, path.basename(resultPath));
  // The generic result verifier checks canonical envelopes and hashes. Confine
  // every reference first; a matching hash never authorizes symlink traversal.
  publicationPath(directory, result.artifact.path);
  publicationPath(directory, result.receipt.path);
  for (const evidence of result.evidence)
    publicationPath(directory, evidence.path);
  return { result, directory };
}

// Provider readback is an independent preceding step. This joins its exact
// operation to the sealed request/result files and returns only signed products.
export function verifyPipelineNativeResults({
  input,
  directory,
  operation,
  authority,
  plan,
  platform,
}) {
  const { root, ...body } = authority;
  const rules = (plan.nativeSigning || []).filter(
    (rule) => rule.platform === platform,
  );
  if (
    authority.schema !== "buildchain.pipeline-native-authority-readback/v1" ||
    root !== recordDigest(body) ||
    authority.operationRoot !== recordDigest(operation) ||
    authority.requestRoot !== input.indexRoot ||
    authority.runtimeSha !== plan.runtime.commit ||
    operation.requestRoot !== input.indexRoot ||
    operation.runtimeSha !== plan.runtime.commit ||
    recordDigest(operation.requestIds) !==
      recordDigest(rules.map((rule) => rule.id)) ||
    recordDigest(input.index.requests.map((item) => item.id)) !==
      recordDigest(operation.requestIds)
  )
    throw new Error(
      "Native authority proof differs from the admitted product requests",
    );
  const index = read(directory, "index.json");
  if (!Array.isArray(index.results) || index.results.length !== rules.length)
    throw new Error(
      "Native result set must cover every declared signing request",
    );
  const results = new Map(
    index.results.map((entry) => [
      entry.id,
      { entry, ...resultFiles(directory, entry) },
    ]),
  );
  if (results.size !== rules.length)
    throw new Error("Native results contain duplicate identifiers");
  verifyArtifactSigningResults({
    requestRoot: input.directory,
    resultRoot: directory,
  });
  const replacements = [],
    receipts = [];
  for (const rule of rules) {
    const found = results.get(rule.id);
    if (!found)
      throw new Error("Native result is missing its declared artifact");
    const requestEntry = input.index.requests.find(
      (item) => item.id === rule.id,
    );
    const request = read(input.directory, requestEntry.path);
    const evidenceEntry = found.result.evidence.filter(
      (item) => item.kind === `${rule.profile}-verification`,
    );
    if (evidenceEntry.length !== 1)
      throw new Error(
        "Native result needs one exact provider evidence document",
      );
    const evidence = read(found.directory, evidenceEntry[0].path);
    let payloads;
    if (rule.kind === "app-bundle") {
      payloads = appPayloads(
        found.directory,
        evidence,
        request,
        found.result,
        authority,
      );
    } else {
      archiveEvidence(evidence, request);
      payloads = [
        {
          kind: "archive",
          path: publicationPath(found.directory, found.result.artifact.path),
          size: found.result.artifact.bytes,
          digest: found.result.artifact.digest,
        },
      ];
    }
    for (const payload of payloads) {
      const artifact = payload.kind === "dmg" ? rule.installer : rule.artifact;
      const output = plan.outputs.find(
        (item) =>
          item.platform === platform &&
          item.product === rule.product &&
          item.artifact === artifact,
      );
      if (!output)
        throw new Error("Native payload has no declared publication output");
      replacements.push({
        id: output.id,
        file: path.relative(directory, payload.path).split(path.sep).join("/"),
        size: payload.size,
        digest: payload.digest,
      });
    }
    receipts.push({
      id: rule.id,
      requestDigest: request.digest,
      resultDigest: found.result.digest,
    });
  }
  return {
    authorityRoot: authority.root,
    requestRoot: input.indexRoot,
    replacements,
    receipts,
  };
}
