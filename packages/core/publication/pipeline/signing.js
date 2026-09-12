import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  canonicalJson,
  recordDigest,
} from "../../release/discussion/envelope.js";
import { verifyPipelineQualification } from "./documents.js";
import { writeImmutablePublicationFile } from "./files.js";

export const PIPELINE_PRODUCT_PREDICATE =
  "https://buildchain.libkungfu.dev/attestations/pipeline-products/v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function preparePipelineSigning({
  plan,
  materialization,
  qualified,
  directory,
  evaluatedAt,
}) {
  verifyPipelineQualification({
    plan,
    materialization,
    qualified,
    evaluatedAt,
  });
  const predicate = {
    schema: "buildchain.pipeline-product-attestation/v1",
    planRoot: plan.root,
    materializationRoot: materialization.root,
    qualificationRoot: qualified.root,
    source: qualified.source,
    protectedSource: plan.source,
    publisher: plan.publisher,
    runtime: plan.runtime,
    provider: {
      runId: qualified.build.runId,
      runAttempt: qualified.build.runAttempt,
      source: qualified.build.providerSource,
    },
  };
  const subjectBytes = Buffer.from(`${canonicalJson(qualified)}\n`);
  const subjectPath = writeImmutablePublicationFile(
    path.join(directory, "qualified-products.json"),
    subjectBytes,
  );
  const predicatePath = writeImmutablePublicationFile(
    path.join(directory, "predicate.json"),
    `${canonicalJson(predicate)}\n`,
  );
  return {
    subjectPath,
    predicatePath,
    predicate,
    subjectDigest: digest(subjectBytes),
    predicateType: PIPELINE_PRODUCT_PREDICATE,
  };
}

export function verifyPipelineSigning({
  plan,
  materialization,
  qualified,
  bundlePath,
  directory,
  token,
  execute = execFileSync,
  evaluatedAt,
}) {
  const prepared = preparePipelineSigning({
    plan,
    materialization,
    qualified,
    directory,
    evaluatedAt,
  });
  const output = execute(
    "gh",
    [
      "attestation",
      "verify",
      prepared.subjectPath,
      "--repo",
      qualified.source.repository,
      "--signer-workflow",
      `${plan.publisher.repository}/${plan.publisher.workflow}`,
      "--signer-digest",
      plan.publisher.workflowSha,
      "--source-digest",
      qualified.build.providerSource,
      "--predicate-type",
      PIPELINE_PRODUCT_PREDICATE,
      "--bundle",
      bundlePath,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GH_TOKEN: token },
    },
  );
  const results = JSON.parse(output);
  const statements = Array.isArray(results)
    ? results
        .map((result) => result.verificationResult?.statement)
        .filter(Boolean)
    : [];
  if (
    statements.length !== 1 ||
    statements[0].predicateType !== prepared.predicateType ||
    recordDigest(statements[0].predicate) !==
      recordDigest(prepared.predicate) ||
    statements[0].subject?.length !== 1 ||
    statements[0].subject[0].digest?.sha256 !== prepared.subjectDigest
  )
    throw new Error(
      "Cryptographically verified attestation does not bind the exact publication predicate and subject",
    );
  if (digest(fs.readFileSync(prepared.subjectPath)) !== prepared.subjectDigest)
    throw new Error("Signed publication subject changed during verification");
  const bundleBytes = fs.readFileSync(bundlePath);
  return {
    schema: "buildchain.pipeline-product-signing/v1",
    verified: true,
    planRoot: plan.root,
    materializationRoot: materialization.root,
    qualificationRoot: qualified.root,
    subjectDigest: `sha256:${prepared.subjectDigest}`,
    predicateRoot: recordDigest(prepared.predicate),
    bundleDigest: `sha256:${digest(bundleBytes)}`,
    signer: plan.publisher,
    providerSource: qualified.build.providerSource,
  };
}
