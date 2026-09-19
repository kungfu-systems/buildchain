import fs from "node:fs";
import path from "node:path";
import { createArtifactSigningRequest } from "../../build/artifact-signing.js";
import {
  archiveSubject,
  subjectDescriptor,
} from "../../build/signing/seal-requests.js";
import { artifactSigningRequestRoot } from "../../build/signing/request.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import {
  publicationFile,
  publicationPath,
  writeImmutablePublicationFile,
  verifyPipelineProductFiles,
} from "./files.js";

const INDEX_CONTRACT = "kungfu-buildchain-artifact-signing-request-index/v1";
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const posix = (value) => value.split(path.sep).join("/");

function requestForRule({
  rule,
  plan,
  source,
  subject,
  descriptor,
  transport,
}) {
  if (
    plan.runtime?.repository !== "kungfu-systems/buildchain" ||
    ![source.commit, source.tree, plan.runtime?.commit].every((sha) =>
      /^[0-9a-f]{40}$/u.test(sha || ""),
    )
  )
    throw new Error(
      "Native input sealing requires exact source, tree and runtime commits",
    );
  return createArtifactSigningRequest({
    source: {
      repository: source.repository,
      sha: source.commit,
      treeSha: source.tree,
    },
    runtime: {
      repository: "kungfu-systems/buildchain",
      sha: plan.runtime.commit,
    },
    artifact: {
      id: rule.id,
      path: subject,
      kind: rule.kind,
      platform: "macos",
      arch: rule.platform.slice("macos-".length),
      bytes: descriptor.bytes,
      digest: descriptor.digest,
      transport,
      ...(rule.bundle_id ? { bundleId: rule.bundle_id } : {}),
    },
    signature: {
      required: true,
      profile: rule.profile,
      ...(rule.entitlements_profile && rule.entitlements_profile !== "none"
        ? {
            entitlementsProfile: rule.entitlements_profile,
            entitlementsPaths: rule.entitlements_paths,
          }
        : {}),
    },
  });
}

function sealRequest({ cwd, output, plan, source, rule, artifacts }) {
  const primary = artifacts.find(
    (item) =>
      item.product === rule.product &&
      item.platform === rule.platform &&
      item.artifact === rule.artifact,
  );
  if (!primary)
    throw new Error("Native request has no declared unsigned artifact");
  const directory = publicationPath(cwd, rule.directory, "directory");
  const subject = rule.kind === "app-bundle" ? rule.path : primary.path;
  const subjectPath = publicationPath(
    directory,
    subject,
    rule.kind === "app-bundle" ? "directory" : "file",
  );
  const descriptor = subjectDescriptor(subjectPath);
  if (
    rule.kind === "archive" &&
    (descriptor.digest !== primary.digest || descriptor.bytes !== primary.size)
  )
    throw new Error(
      "Native archive changed after the unsigned product was sealed",
    );
  const transport = archiveSubject({
    subjectPath,
    outputRoot: output,
    id: rule.id,
    kind: rule.kind,
    platform: "macos",
  });
  if (recordDigest(subjectDescriptor(subjectPath)) !== recordDigest(descriptor))
    throw new Error("Native subject changed while its transport was sealed");
  const request = requestForRule({
    rule,
    plan,
    source,
    subject: posix(path.relative(fs.realpathSync(cwd), subjectPath)),
    descriptor,
    transport,
  });
  const relative = `${rule.id}/request.json`;
  writeImmutablePublicationFile(
    path.join(output, relative),
    jsonBytes(request),
  );
  return { request, relative };
}

// Runs only on the credentialless product builder. The separate controller must
// re-admit the immutable producer and these bytes before dispatching authority.
export function sealPipelineNativeInputs({
  cwd,
  output,
  plan,
  platform,
  source,
  artifacts,
}) {
  const rules = (plan.nativeSigning || []).filter(
    (rule) => rule.platform === platform,
  );
  if (!rules.length) return undefined;
  const requestRoot = "native-signing";
  fs.mkdirSync(path.join(output, requestRoot), { recursive: true });
  const directory = publicationPath(output, requestRoot, "directory");
  const sealed = rules.map((rule) =>
    sealRequest({ cwd, output: directory, plan, source, rule, artifacts }),
  );
  const index = {
    schemaVersion: 1,
    contract: INDEX_CONTRACT,
    requests: sealed.map(({ request, relative }) => ({
      id: request.artifact.id,
      digest: request.digest,
      path: relative,
      required: true,
      profile: request.signature.profile,
      platform: request.artifact.platform,
    })),
  };
  writeImmutablePublicationFile(
    path.join(directory, "index.json"),
    jsonBytes(index),
  );
  const paths = [
    "index.json",
    ...sealed.flatMap(({ request, relative }) => [
      relative,
      request.artifact.transport.file,
    ]),
  ];
  const files = paths.map((relative) => {
    const observed = publicationFile(publicationPath(directory, relative));
    return {
      file: `${requestRoot}/${relative}`,
      size: observed.size,
      digest: observed.digest,
    };
  });
  return { requestRoot, indexRoot: artifactSigningRequestRoot(index), files };
}

function verifyRequest({ entry, rule, requestRoot, manifest, plan, source }) {
  const requestPath = `${rule.id}/request.json`;
  if (
    entry.path !== requestPath ||
    entry.required !== true ||
    entry.profile !== rule.profile
  )
    throw new Error("Native signing index changed required signature intent");
  const request = JSON.parse(
    fs.readFileSync(publicationPath(requestRoot, requestPath), "utf8"),
  );
  const primary = manifest.artifacts.find(
    (a) => a.product === rule.product && a.artifact === rule.artifact,
  );
  if (!primary)
    throw new Error("Native request has no declared unsigned product");
  const subject = rule.kind === "app-bundle" ? rule.path : primary?.path;
  const transportPath = `${rule.id}/${rule.kind === "app-bundle" ? "subject.ditto.zip" : path.posix.basename(subject || "")}`;
  const observed = publicationFile(publicationPath(requestRoot, transportPath));
  if (
    rule.kind === "archive" &&
    (observed.size !== primary.size || observed.digest !== primary.digest)
  )
    throw new Error(
      "Native transport differs from the sealed unsigned archive",
    );
  const rebuilt = requestForRule({
    rule,
    plan,
    source,
    subject: path.posix.join(rule.directory, subject),
    descriptor:
      rule.kind === "archive"
        ? { bytes: primary.size, digest: primary.digest }
        : request.artifact,
    transport: {
      file: transportPath,
      format: rule.kind === "app-bundle" ? "ditto-zip" : "exact-file",
      bytes: observed.size,
      digest: observed.digest,
    },
  });
  if (
    request.digest !== entry.digest ||
    recordDigest(request) !== recordDigest(rebuilt)
  )
    throw new Error(
      "Native request differs from its source and signature declaration",
    );
  const expectedEntry = {
    id: rule.id,
    digest: rebuilt.digest,
    path: requestPath,
    required: true,
    profile: rule.profile,
    platform: "macos",
  };
  const files = [
    `native-signing/${requestPath}`,
    `native-signing/${transportPath}`,
  ];
  return { expectedEntry, files };
}

export function verifyPipelineNativeInputs({
  directory,
  manifest,
  plan,
  source,
}) {
  verifyPipelineProductFiles(directory, manifest);
  const rules = (plan.nativeSigning || []).filter(
    (rule) => rule.platform === manifest.platform,
  );
  const native = manifest.nativeSigning;
  if (!rules.length) {
    if (native !== undefined)
      throw new Error("Unsigned product contains undeclared signing requests");
    return undefined;
  }
  if (native?.requestRoot !== "native-signing" || !Array.isArray(native.files))
    throw new Error("Native request transport is missing");
  if (
    manifest.planRoot !== plan.root ||
    recordDigest(manifest.source) !== recordDigest(source)
  )
    throw new Error(
      "Native request manifest differs from its admitted source and plan",
    );
  const descriptors = manifest.artifacts
    .map(({ file, size, digest, package: pkg, ...descriptor }) => descriptor)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    recordDigest(descriptors) !==
    recordDigest(
      plan.outputs.filter((item) => item.platform === manifest.platform),
    )
  )
    throw new Error(
      "Native input artifacts differ from the declared unsigned products",
    );
  if (
    native.files.length !== 1 + 2 * rules.length ||
    new Set(native.files.map((item) => item.file)).size !== native.files.length
  )
    throw new Error(
      "Native transport file inventory is incomplete or duplicated",
    );
  const requestRoot = publicationPath(
    directory,
    native.requestRoot,
    "directory",
  );
  const index = JSON.parse(
    fs.readFileSync(publicationPath(requestRoot, "index.json"), "utf8"),
  );
  if (
    artifactSigningRequestRoot(index) !== native.indexRoot ||
    recordDigest(index.requests.map((r) => r.id)) !==
      recordDigest(rules.map((r) => r.id))
  )
    throw new Error(
      "Native request index differs from the declared signing inventory",
    );
  const expectedFiles = ["native-signing/index.json"];
  const expectedEntries = [];
  for (const [position, rule] of rules.entries()) {
    const entry = index.requests[position];
    const verified = verifyRequest({
      entry,
      rule,
      requestRoot,
      manifest,
      plan,
      source,
    });
    expectedEntries.push(verified.expectedEntry);
    expectedFiles.push(...verified.files);
  }
  if (
    recordDigest(index) !==
    recordDigest({
      schemaVersion: 1,
      contract: INDEX_CONTRACT,
      requests: expectedEntries,
    })
  )
    throw new Error(
      "Native signing index contains unsupported request authority",
    );
  if (
    recordDigest(native.files.map((item) => item.file)) !==
    recordDigest(expectedFiles)
  )
    throw new Error(
      "Native transport must cover exactly its declared request files",
    );
  return { directory: requestRoot, index, indexRoot: native.indexRoot };
}
