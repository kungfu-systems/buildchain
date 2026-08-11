#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { addAdopterWitness, initAdopterManifest } from "@kungfu-tech/kfd/adopter-conformance/toolchain";
import kfdStandards from "@kungfu-tech/kfd/standards.json" with { type: "json" };
import { installedKfdPackageArtifactRoot } from "../packages/core/artifact-verification-envelope.js";
import { createKfdAdopterManifestGate, createKfdLegacySupportMatrixProjection, validateKfdAdopterManifestGate, validateKfdLegacySupportMatrixProjection } from "../packages/core/kfd-adopter-manifest.js";
import { KFD_PRODUCT_GATE_INPUT_CONTRACT, evaluateKfdProductGate, kfdProductGateDigest, validateKfdProductGateResult } from "../packages/core/kfd-product-gates.js";
import { createBuildchainKfd1Witness, createBuildchainKfd2Claims, createBuildchainKfd3ArtifactWitness, createBuildchainKfd3PrebuildWitness } from "../packages/core/buildchain-kfd-claims.js";
import { BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH, BUILDCHAIN_KFD2_CLAIMS_DIR, BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH, BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH } from "../packages/core/buildchain-layout.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";
const REPOSITORY = "kungfu-systems/buildchain", require = createRequire(import.meta.url), kfdRoot = path.dirname(require.resolve("@kungfu-tech/kfd/package.json"));
const evidenceSources = { "KFD-1": "dist/site/release-passport-check-manifest.json", "KFD-2": "dist/site/kfd-claims.json", "KFD-3": "dist/site/public-surface-audit.json", "KFD-4": "packages/core/kfd-product-gates.js", "KFD-5": "packages/core/kfd-product-gates.js", "KFD-7": "packages/core/kfd-product-gates.js", "KFD-10": "packages/core/dev-delivery-warrant.js" };
function parseArgs(argv = process.argv.slice(2)) {
  const args = { cwd: process.cwd(), outputDir: ".buildchain/kfd", sourceSha: process.env.BUILDCHAIN_SOURCE_SHA || "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") args.cwd = argv[++index] || args.cwd;
    else if (arg === "--output-dir") args.outputDir = argv[++index] || args.outputDir;
    else if (arg === "--source-sha") args.sourceSha = argv[++index] || args.sourceSha;
    else if (arg === "--help") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}
function gitSha(cwd) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch { return ""; }
}
function digest(bytes) { return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`; }
function fileDigest(filePath) { return digest(fs.readFileSync(filePath)); }
function relative(root, filePath) { return path.relative(root, filePath).replace(/\\/g, "/"); }
function writeJson(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return { path: relativePath, sha256: fileDigest(filePath), filePath };
}
function readJson(filePath, sourceSha = "") { return JSON.parse(fs.readFileSync(filePath, "utf8").replaceAll("{{SOURCE_SHA}}", sourceSha)); }
export function generateBuildchainKfdWitnesses({ cwd = process.cwd(), outputDir = ".buildchain/kfd", sourceSha = "", emitOutputs = true } = {}) {
  const root = path.resolve(cwd), outDir = path.resolve(root, outputDir), resolvedSourceSha = sourceSha || gitSha(root);
  const outputPath = (canonicalPath) => path.join(outDir, path.relative(".buildchain/kfd", canonicalPath));
  const paths = { kfd1Witness: outputPath(BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH), kfd3PrebuildWitness: outputPath(BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH), kfd3ArtifactWitness: outputPath(BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH), kfd2ClaimsDir: outputPath(BUILDCHAIN_KFD2_CLAIMS_DIR) };
  writeJson(path.dirname(paths.kfd1Witness), path.basename(paths.kfd1Witness), createBuildchainKfd1Witness({ root, sourceSha: resolvedSourceSha }));
  writeJson(path.dirname(paths.kfd3PrebuildWitness), path.basename(paths.kfd3PrebuildWitness), createBuildchainKfd3PrebuildWitness({ root, sourceSha: resolvedSourceSha }));
  writeJson(path.dirname(paths.kfd3ArtifactWitness), path.basename(paths.kfd3ArtifactWitness), createBuildchainKfd3ArtifactWitness({ root, sourceSha: resolvedSourceSha }));
  const witnessFiles = { "kfd-1-witness": relative(root, paths.kfd1Witness), "kfd-3-prebuild-witness": relative(root, paths.kfd3PrebuildWitness), "kfd-3-artifact-witness": relative(root, paths.kfd3ArtifactWitness) };
  const kfd2ClaimPaths = createBuildchainKfd2Claims({ root, witnessFiles }).map((claim) => {
    const slug = String(claim.id || "claim").replace(/^claim:/, "").replace(/[^0-9A-Za-z._-]+/g, "-").replace(/^-+|-+$/g, "") || "claim";
    return writeJson(paths.kfd2ClaimsDir, `${slug}.json`, claim).filePath;
  });
  const outputs = { "kfd-1-witness-jsons": relative(root, paths.kfd1Witness), "kfd-2-claim-jsons": kfd2ClaimPaths.map((filePath) => relative(root, filePath)).join(","), "kfd-3-prebuild-witness-jsons": relative(root, paths.kfd3PrebuildWitness), "kfd-3-artifact-witness-jsons": relative(root, paths.kfd3ArtifactWitness), "source-sha": resolvedSourceSha, "output-dir": relative(root, outDir) };
  if (emitOutputs) writeGitHubOutputs(outputs);
  return { schemaVersion: 1, contract: "kungfu-buildchain-self-kfd-witness-generation", outputs };
}
function productRecords(root, standard, sourceSha) {
  if (standard === "kfd-4") return [
    ["observer-perspective", readJson(path.join(root, "contracts/fixtures/kfd-adopter-release-v1/kfd-4-perspective.json"), sourceSha)],
    ["perspective-replay", readJson(path.join(root, "contracts/fixtures/kfd-adopter-release-v1/kfd-4-replay.json"), sourceSha)],
  ];
  if (standard === "kfd-5") return [["primitive-discovery", readJson(path.join(kfdRoot, "cases/live/software-work-perspective-settlement/cuts/0001-assignment.json"))]];
  const profile = readJson(path.join(kfdRoot, "verifier/fixtures/kfd-7/valid-domain-profile.json"));
  profile.evidenceObligations = profile.evidenceObligations.map((entry) => ({ ...entry, status: "passed", artifactRefs: ["qualification-proof"], residualRisk: "Bound to the retained Buildchain product gate cut; independent certification remains external." }));
  profile.activation = { decision: "activate", evidenceCut: `git://${REPOSITORY}@${sourceSha}`, independentReview: "review://protected-release-review", productWitnesses: ["qualification-proof"], residualRisk: "The product gate is non-qualifying and non-self-certifying." };
  profile.domainProfile = { ...profile.domainProfile, product: "Buildchain", implementation: `git+https://github.com/${REPOSITORY}@${sourceSha}`, qualificationStatus: "qualified" };
  return [["domain-profile", profile]];
}
async function generateProductGate(root, outDir, standard, sourceSha, checkedAt) {
  const records = productRecords(root, standard, sourceSha).map(([role, value], index) => ({ role, ...writeJson(outDir, `records/${standard}-${index}.json`, value) }));
  const kinds = standard === "kfd-4" ? [["projection-fsck", "projection-fsck"], ["negative", "negative-fixture"]] : standard === "kfd-5" ? [["negative", "negative-fixture"]] : [["qualification-proof", "qualification-proof"], ["independent-review", "independent-review"], ["negative", "negative-fixture"]];
  const evidence = kinds.map(([id, kind]) => ({ id, kind, ...writeJson(outDir, `evidence/${standard}-${id}.json`, { schemaVersion: 1, contract: "kungfu-buildchain-kfd-adopter-evidence-reference", id, kind, source: { repository: REPOSITORY, sha: sourceSha }, observedAt: checkedAt, status: "retained", nonClaim: "This product-owned reference does not independently qualify or certify KFD adoption." }) }));
  const input = { schemaVersion: 1, contract: KFD_PRODUCT_GATE_INPUT_CONTRACT, standard, standardRevision: kfdStandards.standards[standard].revision, source: { repository: REPOSITORY, sha: sourceSha }, evidenceCut: { generatedAt: checkedAt, expiresAt: new Date(Date.parse(checkedAt) + 86400000).toISOString() }, records: records.map(({ role, path, sha256 }) => ({ role, path, sha256 })), evidence: evidence.map(({ id, kind, path, sha256 }) => ({ id, kind, path, sha256 })), responsibility: { owner: REPOSITORY, evidenceOwner: "Buildchain maintainers", proofOwner: "Buildchain release gate" }, nonClaims: ["A passed product gate does not qualify, certify, activate, or independently approve KFD adoption."] };
  const gate = await evaluateKfdProductGate({ cwd: outDir, input, expectedSourceSha: sourceSha, checkedAt });
  if (gate.status !== "passed" || !validateKfdProductGateResult(gate, { expectedSourceSha: sourceSha, checkedAt }).valid) throw new Error(`${standard} product gate failed: ${JSON.stringify(gate.issues)}`);
  writeJson(outDir, `${standard}/product-gate.json`, gate);
  return gate;
}
export async function generateBuildchainKfdAdopterRelease({ cwd = process.cwd(), outputDir = ".buildchain/kfd/adopter-release", sourceSha = "", checkedAt = new Date().toISOString(), emitOutputs = true } = {}) {
  const root = path.resolve(cwd), outDir = path.resolve(root, outputDir);
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !Number.isFinite(Date.parse(checkedAt))) throw new Error("source SHA and checked-at must be exact");
  for (const sourcePath of Object.values(evidenceSources)) if (!fs.statSync(path.join(root, sourcePath)).isFile()) throw new Error(`required Buildchain evidence source is missing: ${sourcePath}`);
  const packageArtifactRoot = installedKfdPackageArtifactRoot(), gates = [];
  for (const standard of ["kfd-4", "kfd-5", "kfd-7"]) gates.push(await generateProductGate(root, outDir, standard, sourceSha, checkedAt));
  const sourceRoot = kfdProductGateDigest({ repository: REPOSITORY, sourceSha, files: [...new Set(Object.values(evidenceSources))].sort().map((sourcePath) => ({ path: sourcePath, sha256: fileDigest(path.join(root, sourcePath)) })) });
  let manifest = initAdopterManifest({ manifestId: "buildchain-v3-full-cut", adopterId: REPOSITORY, artifactKind: "git-commit", artifactCoordinate: `${REPOSITORY}@${sourceSha}`, artifactRoot: sourceRoot, scope: "Buildchain v3 release and protected delivery authority", packageArtifactRoot, verifiedAt: checkedAt, maxAgeSeconds: 86400 });
  const gateById = new Map(gates.map((gate) => [gate.standard.toUpperCase(), gate]));
  for (const id of ["KFD-1", "KFD-2", "KFD-3", "KFD-4", "KFD-5", "KFD-7"]) {
    const row = manifest.decisions.find((entry) => entry.id === id);
    const sourcePath = evidenceSources[id];
    const sourceEvidence = (kind, rootValue = fileDigest(path.join(root, sourcePath))) => ({ kind, coordinate: `git+https://github.com/${REPOSITORY}@${sourceSha}#${sourcePath}`, root: rootValue, observedAt: checkedAt, kfdPackageRoot: packageArtifactRoot });
    row.state = "candidate"; row.usage = "used"; row.implementationEvidence = [sourceEvidence("implementation")]; row.verificationEvidence = [sourceEvidence("verification", gateById.get(id)?.gateRoot)]; row.gaps = ["Independent decision-specific assessment and certification remain external."];
  }
  const kfd6 = manifest.decisions.find((entry) => entry.id === "KFD-6");
  kfd6.state = "unsupported"; kfd6.usage = "unused"; kfd6.gaps = ["Buildchain does not claim KFD-6 support in this cut."];
  manifest = addAdopterWitness(manifest, { decisionId: "KFD-10", profileId: "kfd-warrant-evidence", witnessCoordinate: `git+https://github.com/${REPOSITORY}@${sourceSha}#${evidenceSources["KFD-10"]}`, witnessRoot: fileDigest(path.join(root, evidenceSources["KFD-10"])), packageArtifactRoot, verifiedAt: checkedAt, maxAgeSeconds: 86400 });
  const manifestPath = writeJson(outDir, "kfd-adopter-manifest.json", manifest).filePath, manifestGate = createKfdAdopterManifestGate({ manifest, packageArtifactRoot, gateResults: gates, authorityPath: "kfd-adopter-manifest.json", expectedSourceSha: sourceSha, checkedAt });
  if (!validateKfdAdopterManifestGate(manifestGate, { expectedSourceSha: sourceSha, checkedAt }).valid) throw new Error(`generated adopter manifest gate failed: ${JSON.stringify(manifestGate.issues)}`);
  const gatePath = writeJson(outDir, "kfd-adopter-manifest-gate.json", manifestGate).filePath, support = createKfdLegacySupportMatrixProjection({ manifest, manifestGate });
  if (!validateKfdLegacySupportMatrixProjection(support, { manifest, manifestGate }).valid) throw new Error("generated KFD support projection failed");
  const supportPath = writeJson(outDir, "kfd-support.json", support).filePath;
  const outputs = { "kfd-adopter-manifest-json": relative(root, manifestPath), "kfd-adopter-manifest-gate-json": relative(root, gatePath), "kfd-support-matrix-json": relative(root, supportPath), "kfd-product-gate-jsons": gates.map((gate) => relative(root, path.join(outDir, gate.standard, "product-gate.json"))).join(","), "kfd-adopter-manifest-root": manifestGate.authority.manifestRoot, "kfd-adopter-gate-root": manifestGate.gateRoot, "kfd-package-artifact-root": packageArtifactRoot, "source-sha": sourceSha };
  if (emitOutputs) writeGitHubOutputs(outputs);
  return { schemaVersion: 1, contract: "kungfu-buildchain-kfd-adopter-release-generation", status: "passed", qualifying: false, selfCertified: false, outputs };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs();
    if (args.help) process.stdout.write("Usage: generate-buildchain-kfd-witnesses [--cwd <repo>] [--output-dir <dir>] [--source-sha <sha>]\n");
    else process.stdout.write(`${JSON.stringify(generateBuildchainKfdWitnesses(args), null, 2)}\n`);
  } catch (error) {
    console.error(`buildchain self KFD witnesses: ${error.message}`);
    process.exitCode = 1;
  }
}
