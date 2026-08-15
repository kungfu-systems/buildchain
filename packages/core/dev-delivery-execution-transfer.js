import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { verifyNativeQualificationProof } from "./dev-delivery-native-proof.js";
import { verifyNativeExecutionFailureOutcome } from "./dev-delivery-execution-failure.js";

export const NATIVE_EXECUTION_TRANSFER_SCHEMA =
  "kungfu.buildchain.native-execution-job-transfer/v2";
export const NATIVE_EXECUTION_TRANSFER_MANIFEST = "execution-transfer.json";

const SUCCESS_FILES = [
  "native-job-context.json",
  "native-proof.json",
  "native-reuse-decision.json",
  "runtime-selection.json",
  "two-phase-native-result.json",
  "warrant.json",
];
const FAILURE_FILES = [
  "failure-provider-settlement.json",
  "failure.json",
  "native-job-context.json",
  "runtime-selection.json",
  "warrant.json",
];

const V4_RUNTIME_SELECTOR =
  /^(?:v4|v4-alpha|train\/v4\/v4\.0\/[a-z0-9][a-z0-9._-]*)$/u;

function requiredFiles(outcome) {
  if (outcome === "succeeded") return SUCCESS_FILES;
  if (outcome === "failed") return FAILURE_FILES;
  throw new Error("native execution transfer outcome is unsupported");
}

function relativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "transfer file path must be a normalized archive-relative path",
    );
  }
  return normalized;
}

function exactPathSet(paths, label) {
  if (!Array.isArray(paths)) throw new Error(`${label} must be an array`);
  const normalized = paths.map(relativePath);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate paths`);
  }
  const caseFolded = normalized.map((entry) =>
    entry.toLocaleLowerCase("en-US"),
  );
  if (new Set(caseFolded).size !== caseFolded.length) {
    throw new Error(`${label} contains case-colliding paths`);
  }
  return normalized.sort();
}

function fileBytes(directory, relative) {
  const root = path.resolve(directory);
  const file = path.resolve(root, relativePath(relative));
  if (file === root || !file.startsWith(`${root}${path.sep}`)) {
    throw new Error("transfer file escapes the artifact directory");
  }
  const before = fs.lstatSync(file, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${relative} is not a regular transfer file`);
  }
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file, { bigint: true });
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
    if (before[field] !== after[field]) {
      throw new Error(`transfer file mutated while reading: ${relative}`);
    }
  }
  return bytes;
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function transferFile(directory, relative) {
  return {
    path: relativePath(relative),
    byteRoot: sha256Bytes(fileBytes(directory, relative)),
  };
}

function canonicalJsonFile(directory, relative, label) {
  const bytes = fileBytes(directory, relative);
  const value = JSON.parse(bytes);
  const canonical = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (!bytes.equals(canonical)) {
    throw new Error(`${label} is not canonical JSON bytes`);
  }
  return value;
}

function producerBinding(input = {}) {
  const producer = {
    workflowRunId: positiveInteger(input.workflowRunId, "workflow run id"),
    workflowRunAttempt: positiveInteger(
      input.workflowRunAttempt,
      "workflow run attempt",
    ),
    job: text(input.job),
    runnerEnvironment: text(input.runnerEnvironment),
    runnerName: text(input.runnerName),
    runnerOs: text(input.runnerOs),
    runnerArch: text(input.runnerArch),
  };
  if (Object.values(producer).some((value) => value === "")) {
    throw new Error("native execution producer binding is incomplete");
  }
  return producer;
}

function sealerBinding(input = {}) {
  const sealer = {
    job: text(input.job),
    runnerEnvironment: text(input.runnerEnvironment),
    runnerName: text(input.runnerName),
    runnerOs: text(input.runnerOs),
    runnerArch: text(input.runnerArch),
  };
  if (Object.values(sealer).some((value) => value === "")) {
    throw new Error("native execution sealer binding is incomplete");
  }
  if (sealer.runnerEnvironment !== "github-hosted") {
    throw new Error(
      "native execution seal requires a GitHub-hosted fresh runner",
    );
  }
  return sealer;
}

function runtimeBinding(input = {}) {
  const runtime = {
    repository: repository(input.repository),
    selector: text(input.selector, "runtime selector"),
    resolvedSha: exactSha(input.resolvedSha, "resolved runtime SHA"),
    selectionRoot: exactRoot(input.selectionRoot, "runtime selection root"),
  };
  if (!V4_RUNTIME_SELECTOR.test(runtime.selector)) {
    throw new Error(
      "runtime selector must be v4, v4-alpha, or train/v4/v4.0/<capability>",
    );
  }
  return runtime;
}

function nativeJobContext(input = {}) {
  return {
    schema: "kungfu.buildchain.native-job-context/v1",
    workflowRunId: positiveInteger(input.workflowRunId, "workflow run id"),
    workflowRunAttempt: positiveInteger(
      input.workflowRunAttempt,
      "workflow run attempt",
    ),
    job: text(input.job),
    runnerEnvironment: text(input.runnerEnvironment),
    runnerName: text(input.runnerName),
    runnerOs: text(input.runnerOs),
    runnerArch: text(input.runnerArch),
    outcome: text(input.outcome),
    evidenceCompletedAt: timestamp(
      input.evidenceCompletedAt,
      "native evidence completion time",
    ),
  };
}

function verifiedRuntimeSelection(directory, expected = {}) {
  const selection = canonicalJsonFile(
    directory,
    "runtime-selection.json",
    "runtime selection",
  );
  const normalized = {
    schema: "kungfu.buildchain.dev-delivery-runtime-selection/v1",
    repository: repository(selection.repository),
    selector: text(selection.selector, "runtime selector"),
    resolvedSha: exactSha(selection.resolvedSha, "resolved runtime SHA"),
  };
  if (JSON.stringify(selection) !== JSON.stringify(normalized)) {
    throw new Error("runtime selection is not exact canonical content");
  }
  if (!V4_RUNTIME_SELECTOR.test(normalized.selector)) {
    throw new Error(
      "runtime selector must be v4, v4-alpha, or train/v4/v4.0/<capability>",
    );
  }
  const selectionRoot = sha256Bytes(
    Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`),
  );
  const runtime = runtimeBinding({ ...normalized, selectionRoot });
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && runtime[field] !== value) {
      throw new Error(`runtime selection ${field} mismatch`);
    }
  }
  return runtime;
}

function warrantBinding(input = {}) {
  return {
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    stateRoot: exactRoot(input.stateRoot, "Warrant state root"),
    candidateId: exactRoot(input.candidateId, "Warrant candidate id"),
    fencingToken: exactRoot(input.fencingToken, "Warrant fencing token"),
    generation: positiveInteger(input.generation, "Warrant generation"),
    pullRequestNumber: positiveInteger(
      input.pullRequestNumber,
      "Warrant pull request number",
    ),
    sourceHead: exactSha(input.sourceHead, "Warrant source head"),
  };
}

function warrantEvidence(directory, transfer) {
  const result = canonicalJsonFile(directory, "warrant.json", "Warrant result");
  const warrant = result.observation?.activeWarrant || result.warrant;
  if (!warrant) throw new Error("native transfer Warrant evidence is missing");
  const derived = warrantBinding({
    ...warrant,
    repository: warrant.repository || result.observation?.repository,
    protectedBase: warrant.protectedBase || result.observation?.protectedBase,
    stateRoot: result.observation?.stateRoot || result.after?.stateRoot,
  });
  if (JSON.stringify(derived) !== JSON.stringify(transfer.warrant)) {
    throw new Error("native transfer Warrant evidence binding mismatch");
  }
  return warrant;
}

function enumerate(directory, relativeDirectory = "") {
  const absolute = path.join(directory, relativeDirectory);
  const entries = [];
  for (const name of fs.readdirSync(absolute)) {
    const relative = relativeDirectory
      ? `${relativeDirectory.replaceAll(path.sep, "/")}/${name}`
      : name;
    const normalized = relativePath(relative);
    const entry = fs.lstatSync(path.join(directory, relative), {
      bigint: true,
    });
    if (entry.isSymbolicLink()) {
      throw new Error(`transfer artifact contains symlink: ${normalized}`);
    }
    if (entry.isDirectory()) {
      entries.push({ path: normalized, type: "directory" });
      entries.push(...enumerate(directory, relative));
    } else if (entry.isFile()) {
      entries.push({
        path: normalized,
        type: "file",
        byteRoot: sha256Bytes(fileBytes(directory, relative)),
      });
    } else {
      throw new Error(
        `transfer artifact contains non-regular entry: ${normalized}`,
      );
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function verifyClosedDirectory(directory, declaredFiles) {
  const expected = exactPathSet(
    [NATIVE_EXECUTION_TRANSFER_MANIFEST, ...declaredFiles],
    "transfer artifact membership",
  );
  const first = enumerate(path.resolve(directory));
  exactPathSet(
    first.map((entry) => entry.path),
    "downloaded transfer artifact",
  );
  if (first.some((entry) => entry.type !== "file")) {
    throw new Error(
      "downloaded transfer artifact contains a non-regular entry",
    );
  }
  if (
    JSON.stringify(first.map((entry) => entry.path)) !==
    JSON.stringify(expected)
  ) {
    throw new Error("downloaded transfer artifact membership mismatch");
  }
  return first;
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function stageNativeExecutionTransfer({
  sourceDirectory,
  stagingDirectory,
  files,
} = {}) {
  const source = path.resolve(sourceDirectory);
  const staging = path.resolve(stagingDirectory);
  const declared = exactPathSet(files, "native transfer files");
  fs.mkdirSync(staging, { recursive: false });
  for (const relative of declared) {
    const destination = path.join(staging, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, fileBytes(source, relative), {
      flag: "wx",
      mode: 0o444,
    });
  }
  return staging;
}

export function createNativeExecutionTransfer({
  directory,
  files,
  outcome,
  producer,
  sealer,
  runtime,
  warrant,
  nativeProofRoot = null,
  nativeReuseDecisionRoot = null,
  completedAt,
  sealedAt,
} = {}) {
  const declared = exactPathSet(files, "native transfer files");
  if (JSON.stringify(declared) !== JSON.stringify(requiredFiles(outcome))) {
    throw new Error("native execution transfer required file set mismatch");
  }
  const body = {
    schema: NATIVE_EXECUTION_TRANSFER_SCHEMA,
    outcome,
    producer: producerBinding(producer),
    sealer: sealerBinding(sealer),
    runtime: runtimeBinding(runtime),
    warrant: warrantBinding(warrant),
    nativeProofRoot: nativeProofRoot
      ? exactRoot(nativeProofRoot, "native proof root")
      : null,
    nativeReuseDecisionRoot: nativeReuseDecisionRoot
      ? exactRoot(nativeReuseDecisionRoot, "native reuse decision root")
      : null,
    files: declared.map((file) => transferFile(directory, file)),
    completedAt: timestamp(completedAt, "native transfer completion time"),
    sealedAt: timestamp(sealedAt, "native transfer seal time"),
  };
  if (body.producer.runnerEnvironment !== "github-hosted") {
    throw new Error("native execution requires a GitHub-hosted fresh runner");
  }
  if (
    body.producer.job === body.sealer.job ||
    body.producer.runnerName === body.sealer.runnerName
  ) {
    throw new Error("native execution and seal domains are not distinct");
  }
  if (Date.parse(body.completedAt) >= Date.parse(body.sealedAt)) {
    throw new Error("native execution seal must follow native completion");
  }
  return { ...body, transferRoot: devDeliveryContentRoot(body) };
}

function verifySuccessOutcome(transfer, directory, warrant) {
  exactRoot(transfer.nativeProofRoot, "native proof root");
  exactRoot(transfer.nativeReuseDecisionRoot, "native reuse decision root");
  const result = canonicalJsonFile(
    directory,
    "two-phase-native-result.json",
    "two-phase native result",
  );
  const proof = canonicalJsonFile(
    directory,
    "native-proof.json",
    "native proof",
  );
  const decision = canonicalJsonFile(
    directory,
    "native-reuse-decision.json",
    "native proof reuse decision",
  );
  const proofVerification = verifyNativeQualificationProof(proof);
  const decisionBody = clone(decision);
  const decisionRoot = exactRoot(
    decisionBody.decisionRoot,
    "native proof reuse decision root",
  );
  delete decisionBody.decisionRoot;
  if (
    !proofVerification.ok ||
    result.nativeProofRoot !== transfer.nativeProofRoot ||
    proof.proofRoot !== transfer.nativeProofRoot ||
    result.nativeReuseDecisionRoot !== transfer.nativeReuseDecisionRoot ||
    decisionRoot !== transfer.nativeReuseDecisionRoot ||
    devDeliveryContentRoot(decisionBody) !== decisionRoot ||
    decision.proofRoot !== proof.proofRoot ||
    decision.reusable !== true ||
    proof.repository !== transfer.warrant.repository ||
    proof.protectedBase !== transfer.warrant.protectedBase ||
    proof.sourceHead !== transfer.warrant.sourceHead ||
    proof.qualifiedBase !== warrant.qualifiedBase ||
    proof.sourceIdentityRoot !== warrant.sourceIdentityRoot ||
    proof.sourcePatchRoot !== warrant.sourcePatchRoot ||
    proof.planRoot !== warrant.planRoot ||
    proof.closureRoot !== warrant.closureRoot ||
    proof.dependencyRoot !== warrant.dependencyRoot ||
    proof.toolchainRoot !== warrant.toolchainRoot ||
    proof.environmentRoot !== warrant.environmentRoot ||
    proof.nativeCommandRoot !== warrant.nativeCommandContract?.commandRoot ||
    JSON.stringify(proof.affectedPaths) !==
      JSON.stringify(warrant.affectedPaths) ||
    JSON.stringify(proof.shardEvidenceRoots) !==
      JSON.stringify(
        [
          ...(warrant.shardEvidenceRoots || []),
          proof.nativeExecutionReceiptRoot,
        ].sort(),
      )
  ) {
    throw new Error(
      "native execution transfer proof or reuse semantics mismatch",
    );
  }
  return { failure: null, failureSettlement: null };
}

export function verifyNativeExecutionTransfer(
  transferInput,
  { directory, expected = {} } = {},
) {
  const diskManifest = canonicalJsonFile(
    directory,
    NATIVE_EXECUTION_TRANSFER_MANIFEST,
    "native execution transfer manifest",
  );
  if (JSON.stringify(diskManifest) !== JSON.stringify(transferInput)) {
    throw new Error(
      "downloaded transfer manifest does not match verified content",
    );
  }
  const transfer = clone(transferInput || {});
  if (transfer.schema !== NATIVE_EXECUTION_TRANSFER_SCHEMA) {
    throw new Error("native execution transfer schema is unsupported");
  }
  const transferRoot = exactRoot(
    transfer.transferRoot,
    "execution transfer root",
  );
  delete transfer.transferRoot;
  if (devDeliveryContentRoot(transfer) !== transferRoot) {
    throw new Error("native execution transfer root drift");
  }
  const declared = exactPathSet(
    (transfer.files || []).map((entry) => entry?.path),
    "native execution transfer manifest",
  );
  if (
    JSON.stringify(declared) !== JSON.stringify(requiredFiles(transfer.outcome))
  ) {
    throw new Error("native execution transfer required file set mismatch");
  }
  if (transfer.files.length !== declared.length) {
    throw new Error(
      "native execution transfer contains duplicate file records",
    );
  }
  if (
    JSON.stringify(transfer.producer) !==
      JSON.stringify(producerBinding(transfer.producer)) ||
    JSON.stringify(transfer.sealer) !==
      JSON.stringify(sealerBinding(transfer.sealer)) ||
    JSON.stringify(transfer.runtime) !==
      JSON.stringify(runtimeBinding(transfer.runtime)) ||
    JSON.stringify(transfer.warrant) !==
      JSON.stringify(warrantBinding(transfer.warrant))
  ) {
    throw new Error("native execution transfer binding is not normalized");
  }
  timestamp(transfer.completedAt, "native transfer completion time");
  timestamp(transfer.sealedAt, "native transfer seal time");
  if (
    transfer.producer.job === transfer.sealer.job ||
    transfer.producer.runnerName === transfer.sealer.runnerName ||
    Date.parse(transfer.completedAt) >= Date.parse(transfer.sealedAt)
  ) {
    throw new Error("native execution and seal isolation is missing");
  }
  const first = verifyClosedDirectory(directory, declared);
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actual = field.startsWith("producer.")
      ? transfer.producer?.[field.slice(9)]
      : field.startsWith("runtime.")
        ? transfer.runtime?.[field.slice(8)]
        : field.startsWith("warrant.")
          ? transfer.warrant?.[field.slice(8)]
          : transfer[field];
    if (expectedValue !== undefined && actual !== expectedValue) {
      throw new Error(`native execution transfer ${field} mismatch`);
    }
  }
  if (transfer.producer?.runnerEnvironment !== "github-hosted") {
    throw new Error("native execution runner is not GitHub-hosted");
  }
  const byPath = new Map(first.map((entry) => [entry.path, entry]));
  for (const entry of transfer.files) {
    exactRoot(entry.byteRoot, `${entry.path} byte root`);
    if (byPath.get(entry.path)?.byteRoot !== entry.byteRoot) {
      throw new Error(`native execution transfer byte drift: ${entry.path}`);
    }
  }
  const runtime = verifiedRuntimeSelection(directory, {
    repository: transfer.runtime.repository,
    selector: transfer.runtime.selector,
    resolvedSha: transfer.runtime.resolvedSha,
    selectionRoot: transfer.runtime.selectionRoot,
  });
  const warrant = warrantEvidence(directory, transfer);
  const contextInput = canonicalJsonFile(
    directory,
    "native-job-context.json",
    "native job context",
  );
  const context = nativeJobContext(contextInput);
  if (
    JSON.stringify(context) !== JSON.stringify(contextInput) ||
    context.workflowRunId !== transfer.producer.workflowRunId ||
    context.workflowRunAttempt !== transfer.producer.workflowRunAttempt ||
    context.job !== transfer.producer.job ||
    context.runnerEnvironment !== transfer.producer.runnerEnvironment ||
    context.runnerName !== transfer.producer.runnerName ||
    context.runnerOs !== transfer.producer.runnerOs ||
    context.runnerArch !== transfer.producer.runnerArch ||
    context.outcome !== transfer.outcome ||
    context.evidenceCompletedAt !== transfer.completedAt
  ) {
    throw new Error("native job context does not match execution transfer");
  }
  const outcome =
    transfer.outcome === "succeeded"
      ? verifySuccessOutcome(transfer, directory, warrant)
      : verifyNativeExecutionFailureOutcome(transfer, {
          readCanonical: (relative, label) =>
            canonicalJsonFile(directory, relative, label),
        });
  const second = verifyClosedDirectory(directory, declared);
  if (!sameSnapshot(first, second)) {
    throw new Error("native execution transfer mutated during verification");
  }
  return { ...transfer, runtime, transferRoot, ...outcome };
}
