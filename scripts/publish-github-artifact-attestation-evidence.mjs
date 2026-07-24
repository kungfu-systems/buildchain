#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  createGitHubArtifactAttestationVerificationPlan,
  verifyGitHubArtifactAttestationEvidence,
} from "../packages/core/github-artifact-attestation.js";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${key || "<end>"}`);
    result[key.slice(2)] = value;
  }
  return result;
}

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return `sha256:${sha256(fs.readFileSync(filePath))}`;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function safeAssetStem(value) {
  return path.basename(required(value, "subject name"))
    .replace(/[^0-9A-Za-z._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function api({ token, apiUrl, route, method = "GET", headers = {}, body }) {
  const response = await fetch(`${apiUrl}${route}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...headers,
    },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`GitHub API ${method} ${route} failed with ${response.status}: ${detail}`);
  }
  return response;
}

async function remoteAssetDigest({ token, apiUrl, repository, asset }) {
  const declared = String(asset.digest || "").match(/^sha256:([0-9a-f]{64})$/i);
  if (declared) return `sha256:${declared[1].toLowerCase()}`;
  const response = await api({
    token,
    apiUrl,
    route: `/repos/${repository}/releases/assets/${asset.id}`,
    headers: { accept: "application/octet-stream" },
  });
  return `sha256:${sha256(Buffer.from(await response.arrayBuffer()))}`;
}

async function uploadImmutable({ token, apiUrl, repository, release, filePath, assetName }) {
  const localDigest = sha256File(filePath);
  const existing = (release.assets || []).filter((asset) => asset.name === assetName);
  if (existing.length > 1) throw new Error(`release asset ${assetName} exists more than once`);
  if (existing.length === 1) {
    const remoteDigest = await remoteAssetDigest({ token, apiUrl, repository, asset: existing[0] });
    if (remoteDigest !== localDigest) {
      throw new Error(`immutable release asset collision for ${assetName}: ${remoteDigest} != ${localDigest}`);
    }
    return { action: "preserved", name: assetName, digest: localDigest, url: existing[0].browser_download_url };
  }
  const uploadBase = required(release.upload_url, "release.upload_url").replace(/\{.*$/, "");
  const response = await fetch(`${uploadBase}?name=${encodeURIComponent(assetName)}`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-github-api-version": "2022-11-28",
    },
    body: fs.readFileSync(filePath),
  });
  if (!response.ok) throw new Error(`GitHub release asset upload failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const asset = await response.json();
  release.assets = [...(release.assets || []), asset];
  const remoteDigest = await remoteAssetDigest({ token, apiUrl, repository, asset });
  if (remoteDigest !== localDigest) throw new Error(`release asset read-back mismatch for ${assetName}`);
  return { action: "uploaded", name: assetName, digest: localDigest, url: asset.browser_download_url };
}

function appendOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = required(process.env.GITHUB_TOKEN || process.env.GH_TOKEN, "GITHUB_TOKEN");
  const apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const repository = required(options.repository || process.env.GITHUB_REPOSITORY, "repository");
  const tag = required(options.tag, "tag");
  const subjectPath = path.resolve(required(options.subject, "subject"));
  const manifestPath = path.resolve(required(options.manifest, "manifest"));
  const passportPath = path.resolve(required(options.passport, "passport"));
  const bundlePath = path.resolve(required(options.bundle, "bundle"));
  const evidencePath = path.resolve(required(options.evidence, "evidence"));
  const predicatePath = path.resolve(required(options.predicate, "predicate"));
  const providerVerificationPath = path.resolve(required(options["provider-verification"], "provider-verification"));
  const receiptPath = path.resolve(required(options.receipt, "receipt"));
  const evidence = readJson(evidencePath, "Buildchain attestation evidence");
  const plan = createGitHubArtifactAttestationVerificationPlan({ artifactPath: subjectPath, bundlePath, evidence });
  const provider = spawnSync(plan.command, plan.args, { encoding: "utf8", env: process.env });
  if (provider.status !== 0) throw new Error(`gh attestation verify failed: ${String(provider.stderr || provider.stdout).slice(0, 1000)}`);
  const verificationResults = JSON.parse(provider.stdout);
  const local = verifyGitHubArtifactAttestationEvidence({
    artifactPath: subjectPath,
    platformManifestPath: manifestPath,
    releasePassportPath: passportPath,
    bundlePath,
    evidence,
    verificationResults,
  });
  if (!local.ok) throw new Error(`Buildchain evidence verification failed: ${local.issues.map((issue) => issue.message).join("; ")}`);
  const retainedProvider = readJson(providerVerificationPath, "retained provider verification");
  const retained = verifyGitHubArtifactAttestationEvidence({
    artifactPath: subjectPath,
    platformManifestPath: manifestPath,
    releasePassportPath: passportPath,
    bundlePath,
    evidence,
    verificationResults: retainedProvider,
  });
  if (!retained.ok) {
    throw new Error(`retained provider verification failed: ${retained.issues.map((issue) => issue.message).join("; ")}`);
  }
  const releaseResponse = await api({ token, apiUrl, route: `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}` });
  const release = await releaseResponse.json();
  const stem = safeAssetStem(evidence.subject?.name);
  const declarations = [
    [bundlePath, `${stem}.sigstore-bundle.json`],
    [evidencePath, `${stem}.buildchain-attestation.json`],
    [predicatePath, `${stem}.buildchain-predicate.json`],
    [providerVerificationPath, `${stem}.github-verification.json`],
  ];
  const assets = [];
  for (const [filePath, assetName] of declarations) {
    assets.push(await uploadImmutable({ token, apiUrl, repository, release, filePath, assetName }));
  }
  const receipt = {
    contract: "buildchain.github-artifact-attestation-publication/v1",
    repository,
    tag,
    releaseUrl: release.html_url,
    subject: evidence.subject,
    evidenceRoot: evidence.evidenceRoot,
    attestation: evidence.attestation,
    assets,
    verified: true,
  };
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const receiptAsset = await uploadImmutable({
    token,
    apiUrl,
    repository,
    release,
    filePath: receiptPath,
    assetName: `${stem}.buildchain-attestation-publication.json`,
  });
  appendOutput("release-url", release.html_url);
  appendOutput("evidence-root", evidence.evidenceRoot);
  appendOutput("publication-receipt", receiptPath);
  appendOutput("publication-receipt-digest", receiptAsset.digest);
  process.stdout.write(`${JSON.stringify({ ...receipt, receiptAsset }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
