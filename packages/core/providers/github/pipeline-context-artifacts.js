import fs from "node:fs";
import path from "node:path";
import artifact from "@actions/artifact";
import {
  canonicalJson,
  recordDigest,
} from "../../release/discussion/envelope.js";
import { publicationPath } from "../../publication/pipeline/files.js";

const INLINE_LIMIT = 32 * 1024;
const MATERIAL_LIMIT = 16 * 1024 * 1024;
const REFERENCE = "buildchain.pipeline-context-reference/v1";
const SCHEMAS = [
  "buildchain.pipeline-publication-context/v1",
  "buildchain.pipeline-version-context/v1",
];
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function execution(env) {
  const result = {
    repository: env.GITHUB_REPOSITORY,
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(result.repository || "") ||
    !Number.isSafeInteger(result.runId) ||
    result.runId < 1 ||
    !Number.isSafeInteger(result.runAttempt) ||
    result.runAttempt < 1
  )
    throw new Error("Context transfer requires its exact provider execution");
  return result;
}

function projection(value, env) {
  const current = execution(env);
  if (
    !SCHEMAS.includes(value.schema) ||
    value.runId !== current.runId ||
    value.runAttempt !== current.runAttempt
  )
    throw new Error("Context transfer belongs to another provider execution");
  const source =
    value.schema === SCHEMAS[0]
      ? value.materialization?.source
      : value.preparation?.source;
  if (
    source?.repository !== current.repository ||
    !/^[0-9a-f]{40}$/u.test(source?.commit || "")
  )
    throw new Error("Context transfer requires an exact repository source");
  return {
    schema: REFERENCE,
    contextSchema: value.schema,
    ...current,
    contextRoot: recordDigest(value),
    ...(value.schema === SCHEMAS[0]
      ? { materialization: { source } }
      : { preparation: { source } }),
  };
}

function workspace(env) {
  const directory = path.join(
    env.GITHUB_WORKSPACE,
    ".buildchain/context-material",
  );
  fs.mkdirSync(directory, { recursive: true });
  return fs.mkdtempSync(path.join(directory, "transfer-"));
}

// Only an immutable reference and the checkout projection cross job outputs.
// The original context remains unchanged in the authoritative attempt journal.
export async function writePipelineContext(value, env, client = artifact) {
  const serialized = canonicalJson(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= INLINE_LIMIT) return serialized;
  if (bytes > MATERIAL_LIMIT)
    throw new Error("Pipeline context exceeds its retained material bound");
  const selected = projection(value, env);
  const directory = workspace(env);
  try {
    const file = path.join(directory, "context.json");
    fs.writeFileSync(file, serialized, { flag: "wx" });
    const uploaded = await client.uploadArtifact(
      `buildchain-context-${selected.runAttempt}-${selected.contextRoot.slice(7)}`,
      [file],
      directory,
      { retentionDays: 30, compressionLevel: 0 },
    );
    const digest = `sha256:${String(uploaded.digest || "").replace(/^sha256:/u, "")}`;
    if (
      !Number.isSafeInteger(uploaded.id) ||
      uploaded.id < 1 ||
      !DIGEST.test(digest)
    )
      throw new Error("Context upload omitted immutable provider coordinates");
    const encoded = canonicalJson({
      ...selected,
      bytes,
      artifact: { id: uploaded.id, digest },
    });
    if (Buffer.byteLength(encoded) > INLINE_LIMIT)
      throw new Error(
        "Context checkout projection exceeds the job output bound",
      );
    return encoded;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function validateReference(value, env) {
  const current = execution(env);
  if (
    !SCHEMAS.includes(value.contextSchema) ||
    value.repository !== current.repository ||
    value.runId !== current.runId ||
    value.runAttempt !== current.runAttempt ||
    !DIGEST.test(value.contextRoot || "") ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= INLINE_LIMIT ||
    value.bytes > MATERIAL_LIMIT ||
    !Number.isSafeInteger(value.artifact?.id) ||
    value.artifact.id < 1 ||
    !DIGEST.test(value.artifact?.digest || "")
  )
    throw new Error(
      "Context reference changed its execution or material boundary",
    );
}

export async function readPipelineContext(encoded, env, client = artifact) {
  if (Buffer.byteLength(encoded) > INLINE_LIMIT)
    throw new Error("Pipeline context must use bounded job output transport");
  const reference = JSON.parse(encoded);
  if (reference.schema !== REFERENCE) return reference;
  validateReference(reference, env);
  const directory = workspace(env);
  try {
    // No findBy or repository token: the artifact SDK scopes this read to the
    // current workflow execution, including credentialless product build jobs.
    const downloaded = await client.downloadArtifact(reference.artifact.id, {
      path: directory,
      expectedHash: reference.artifact.digest,
    });
    if (
      downloaded.digestMismatch ||
      canonicalJson(fs.readdirSync(directory)) !== '["context.json"]'
    )
      throw new Error("Context artifact changed its archive or file inventory");
    const file = publicationPath(directory, "context.json");
    if (fs.statSync(file).size !== reference.bytes)
      throw new Error("Context artifact changed its retained byte length");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)),
    );
    const expected = {
      ...projection(value, env),
      bytes: reference.bytes,
      artifact: reference.artifact,
    };
    if (recordDigest(expected) !== recordDigest(reference))
      throw new Error(
        "Context artifact differs from its exact checkout projection or root",
      );
    return value;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
