import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSyncCommand } from "./spawn-command.js";

export const KFD_AGENT_HUB_DECLARATION = ".buildchain/kfd/agent-hub.json";
export const KFD_AGENT_HUB_OUTPUT_DIR = ".buildchain/artifacts/kfd-agent-hub";
export const KFD_AGENT_HUB_ADOPTION_CONTRACT = "kungfu-buildchain-kfd-agent-hub-adoption/v1";
export const KFD_AGENT_HUB_LOCK_CONTRACT = "kungfu-buildchain-kfd-agent-hub-lock/v1";
export const KFD_AGENT_HUB_VERIFICATION_CONTRACT = "kungfu-buildchain-kfd-agent-hub-verification/v1";
export const KFD_AGENT_HUB_ADOPTION_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://buildchain.libkungfu.dev/schemas/kfd-agent-hub-adoption.schema.json",
  title: "Buildchain KFD Agent Hub adoption declaration",
  type: "object",
  required: ["schemaVersion", "contract", "profile", "adapter", "capabilities"],
  properties: {
    $schema: { const: "https://buildchain.libkungfu.dev/schemas/kfd-agent-hub-adoption.schema.json" },
    schemaVersion: { const: 1 },
    contract: { const: KFD_AGENT_HUB_ADOPTION_CONTRACT },
    profile: {
      type: "object",
      required: ["package", "id"],
      properties: {
        package: { const: "@kungfu-tech/kfd" },
        id: { const: "kfd-agent-hub-conformance" },
      },
      additionalProperties: false,
    },
    adapter: {
      type: "object",
      required: ["id", "version", "path"],
      properties: {
        id: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        args: { type: "array", items: { type: "string" } },
        build: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      },
      additionalProperties: false,
    },
    capabilities: {
      type: "object",
      required: ["operations", "topologies", "hubBindings"],
      properties: {
        operations: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
        topologies: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
        hubBindings: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});

const PROFILE_PATH = "profiles/agent-hub/manifest.json";
const FAILURE_CODES_PATH = "profiles/agent-hub/failure-codes.json";
const VECTORS_PATH = "profiles/agent-hub/vectors/hub-20.json";
const VERIFIER_PATH = "scripts/agent-hub-report-verifier.mjs";
const RELEASE_PATH = "kfd.release.json";
const REQUIRED_PROFILE_CONTRACT = "kfd.agent-hub-conformance-manifest/v1";
const REQUIRED_REPORT_CONTRACT = "kfd.agent-hub-report/v1";
const PLACEHOLDER_ROOT = /^sha256:0{64}$/;

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function semanticRoot(value) {
  return sha256(`${stableJson(value)}\n`);
}

function readJson(filePath, label = filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`kfd-agent-hub-json-invalid: ${label}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function relative(cwd, filePath) {
  return path.relative(cwd, filePath).split(path.sep).join("/");
}

function exactRoot(value, label) {
  const normalized = String(value || "");
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized) || PLACEHOLDER_ROOT.test(normalized)) {
    throw new Error(`kfd-agent-hub-profile-unreleased: ${label} must be a non-placeholder sha256 root`);
  }
  return normalized;
}

function stringArray(value, label, { min = 1 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`kfd-agent-hub-declaration-invalid: ${label} must contain at least ${min} non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`kfd-agent-hub-declaration-invalid: ${label} must not contain duplicates`);
  }
  return [...value].sort();
}

function argv(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`kfd-agent-hub-declaration-invalid: ${label} must be a non-empty argv array`);
  }
  return [...value];
}

function loadDeclaration({ cwd, declarationPath = KFD_AGENT_HUB_DECLARATION }) {
  const absolutePath = path.resolve(cwd, declarationPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`kfd-agent-hub-declaration-missing: ${relative(cwd, absolutePath)}`);
  }
  const value = readJson(absolutePath, "Agent Hub declaration");
  if (value?.schemaVersion !== 1 || value?.contract !== KFD_AGENT_HUB_ADOPTION_CONTRACT) {
    throw new Error(`kfd-agent-hub-declaration-invalid: expected ${KFD_AGENT_HUB_ADOPTION_CONTRACT}`);
  }
  if (value.profile?.package !== "@kungfu-tech/kfd" || value.profile?.id !== "kfd-agent-hub-conformance") {
    throw new Error("kfd-agent-hub-declaration-invalid: profile must select @kungfu-tech/kfd kfd-agent-hub-conformance");
  }
  const adapterPath = String(value.adapter?.path || "").trim();
  if (!adapterPath) throw new Error("kfd-agent-hub-declaration-invalid: adapter.path is required");
  const absoluteAdapterPath = path.resolve(cwd, adapterPath);
  if (!absoluteAdapterPath.startsWith(`${path.resolve(cwd)}${path.sep}`)) {
    throw new Error("kfd-agent-hub-declaration-invalid: adapter.path must stay inside cwd");
  }
  const adapterId = String(value.adapter.id || "").trim();
  const adapterVersion = String(value.adapter.version || "").trim();
  if (!adapterId || !adapterVersion) {
    throw new Error("kfd-agent-hub-declaration-invalid: adapter.id and adapter.version are required");
  }
  if (value.capabilities?.bindings) {
    throw new Error("kfd-agent-hub-declaration-invalid: use capabilities.hubBindings; runner invocation binding is KFD-owned");
  }
  if (value.adapter.args && (!Array.isArray(value.adapter.args) || value.adapter.args.some((item) => typeof item !== "string"))) {
    throw new Error("kfd-agent-hub-declaration-invalid: adapter.args must be an argv array");
  }
  return {
    path: absolutePath,
    value,
    adapter: {
      id: adapterId,
      version: adapterVersion,
      path: absoluteAdapterPath,
      args: Array.isArray(value.adapter.args) ? value.adapter.args.map(String) : [],
      build: value.adapter.build ? argv(value.adapter.build, "adapter.build") : [],
    },
    capabilities: {
      operations: stringArray(value.capabilities?.operations, "capabilities.operations"),
      topologies: stringArray(value.capabilities?.topologies, "capabilities.topologies"),
      hubBindings: stringArray(value.capabilities?.hubBindings, "capabilities.hubBindings"),
    },
  };
}

function resolveKfdPackage({ cwd, kfdRoot = "" }) {
  let packageJsonPath;
  if (kfdRoot) {
    packageJsonPath = path.join(path.resolve(kfdRoot), "package.json");
  } else {
    const cwdPackage = path.join(path.resolve(cwd), "package.json");
    const consumerRequire = createRequire(fs.existsSync(cwdPackage) ? cwdPackage : path.join(path.resolve(cwd), "noop.js"));
    try {
      packageJsonPath = consumerRequire.resolve("@kungfu-tech/kfd/package.json");
    } catch (consumerError) {
      try {
        packageJsonPath = createRequire(import.meta.url).resolve("@kungfu-tech/kfd/package.json");
      } catch (runtimeError) {
        throw new Error(`kfd-agent-hub-package-missing: install a Buildchain or consumer @kungfu-tech/kfd with the Agent Hub profile (${consumerError.message}; ${runtimeError.message})`);
      }
    }
  }
  const root = path.dirname(packageJsonPath);
  const packageJson = readJson(packageJsonPath, "@kungfu-tech/kfd package.json");
  const required = [PROFILE_PATH, FAILURE_CODES_PATH, VECTORS_PATH, VERIFIER_PATH, RELEASE_PATH];
  for (const requiredPath of required) {
    if (!fs.existsSync(path.join(root, requiredPath))) {
      throw new Error(`kfd-agent-hub-profile-unavailable: @kungfu-tech/kfd@${packageJson.version || "unknown"} is missing ${requiredPath}`);
    }
  }
  const binPath = path.join(root, typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.kfd || "bin/kfd.mjs");
  if (!fs.existsSync(binPath)) throw new Error("kfd-agent-hub-profile-unavailable: @kungfu-tech/kfd does not expose the kfd CLI");
  return { root, packageJson, packageJsonPath, binPath };
}

function inspectKfdCut(kfd) {
  const profilePath = path.join(kfd.root, PROFILE_PATH);
  const failureCodesPath = path.join(kfd.root, FAILURE_CODES_PATH);
  const vectorsPath = path.join(kfd.root, VECTORS_PATH);
  const releasePath = path.join(kfd.root, RELEASE_PATH);
  const verifierPath = path.join(kfd.root, VERIFIER_PATH);
  const profile = readJson(profilePath, PROFILE_PATH);
  readJson(releasePath, RELEASE_PATH);
  if (profile.contract !== REQUIRED_PROFILE_CONTRACT || profile.profile?.id !== "kfd-agent-hub-conformance") {
    throw new Error(`kfd-agent-hub-profile-invalid: ${PROFILE_PATH} must be ${REQUIRED_PROFILE_CONTRACT}`);
  }
  if (profile.adapter?.binding !== "jsonl-stdio/v1" || profile.suite?.id !== "kfd-agent-hub-20") {
    throw new Error("kfd-agent-hub-profile-invalid: expected jsonl-stdio/v1 and kfd-agent-hub-20");
  }
  exactRoot(profile.protocol?.manifestDigest, "profile.protocol.manifestDigest");
  exactRoot(profile.suite?.vectorRoot, "profile.suite.vectorRoot");
  exactRoot(profile.failureInventory?.root, "profile.failureInventory.root");
  exactRoot(profile.runtimeDependency?.manifestDigest, "profile.runtimeDependency.manifestDigest");
  const protocolPath = path.join(kfd.root, String(profile.protocol?.manifest || ""));
  const runtimeDependencyPath = path.join(kfd.root, String(profile.runtimeDependency?.manifest || ""));
  for (const [label, filePath] of [["protocol manifest", protocolPath], ["Runtime 100 manifest", runtimeDependencyPath]]) {
    if (!filePath.startsWith(`${kfd.root}${path.sep}`) || !fs.existsSync(filePath)) {
      throw new Error(`kfd-agent-hub-profile-invalid: ${label} is missing or escaped the KFD package`);
    }
  }
  for (const [label, expected, filePath] of [
    ["protocol manifest", profile.protocol.manifestDigest, protocolPath],
    ["Hub 20 vector registry", profile.suite.vectorRoot, vectorsPath],
    ["failure inventory", profile.failureInventory.root, failureCodesPath],
    ["Runtime 100 manifest", profile.runtimeDependency.manifestDigest, runtimeDependencyPath],
  ]) {
    const actual = sha256(fs.readFileSync(filePath));
    if (actual !== expected) throw new Error(`kfd-agent-hub-profile-root-mismatch: ${label} expected ${expected}, got ${actual}`);
  }
  return {
    package: {
      name: kfd.packageJson.name,
      version: kfd.packageJson.version,
      packageManifestDigest: sha256(fs.readFileSync(kfd.packageJsonPath)),
      releaseAnchorDigest: sha256(fs.readFileSync(releasePath)),
    },
    profile: {
      id: profile.profile.id,
      version: profile.profile.version,
      manifestDigest: sha256(fs.readFileSync(profilePath)),
    },
    protocol: {
      id: profile.protocol.id,
      version: profile.protocol.version,
      manifestDigest: profile.protocol.manifestDigest,
    },
    suite: {
      id: profile.suite.id,
      version: profile.suite.version,
      vectorCount: profile.suite.fixedVectorCount,
      vectorRoot: profile.suite.vectorRoot,
      vectorRegistryDigest: sha256(fs.readFileSync(vectorsPath)),
    },
    failureInventory: {
      root: profile.failureInventory.root,
      digest: sha256(fs.readFileSync(failureCodesPath)),
    },
    verifier: {
      contract: "kfd.agent-hub-report-verifier/v1",
      artifactDigest: sha256(fs.readFileSync(verifierPath)),
    },
    runtimeDependency: {
      id: profile.runtimeDependency.id,
      version: profile.runtimeDependency.version,
      manifestDigest: profile.runtimeDependency.manifestDigest,
      coreVectorCount: profile.runtimeDependency.coreVectorCount,
      experimentalVectorCount: profile.runtimeDependency.experimentalVectorCount,
      qualifying: profile.runtimeDependency.qualifying,
    },
    binding: profile.adapter.binding,
    claimBoundary: profile.claimBoundary,
  };
}

function defaultRun(command, args, { cwd }) {
  const result = spawnSyncCommand(command, args, { cwd, encoding: "utf8", env: process.env });
  return { status: result.status ?? 2, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

function runChecked(run, command, args, options, label) {
  const result = run(command, args, options);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "unknown error").trim();
    throw new Error(`${label}: exit ${result.status ?? 2}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function assertSameSet(declared, actual, label) {
  const normalized = [...new Set(actual.map(String))].sort();
  if (stableJson(declared) !== stableJson(normalized)) {
    throw new Error(`kfd-agent-hub-capability-declaration-mismatch: ${label} declared=${declared.join(",")} observed=${normalized.join(",")}`);
  }
}

function validateReport(report, declaration, cut) {
  if (report?.contract !== REQUIRED_REPORT_CONTRACT || report.valid !== true) {
    throw new Error(`kfd-agent-hub-report-invalid: expected valid ${REQUIRED_REPORT_CONTRACT}`);
  }
  if (report.qualifying !== false || report.certification !== false || report.execution?.offline !== true) {
    throw new Error("kfd-agent-hub-report-invalid: report must remain offline, nonqualifying, and non-certifying");
  }
  if (
    report.sourceCut?.package !== cut.package.name ||
    report.sourceCut?.packageVersion !== cut.package.version ||
    report.sourceCut?.packageManifestDigest !== cut.package.packageManifestDigest ||
    report.sourceCut?.releaseAnchorDigest !== cut.package.releaseAnchorDigest
  ) {
    throw new Error("kfd-agent-hub-source-cut-mismatch: report package cut differs from the resolved KFD package");
  }
  if (
    report.profile?.manifestDigest !== cut.profile.manifestDigest ||
    report.protocol?.manifestDigest !== cut.protocol.manifestDigest ||
    report.suite?.vectorRoot !== cut.suite.vectorRoot ||
    report.suite?.inventoryRoot !== cut.failureInventory.root ||
    report.verifier?.failureInventoryRoot !== cut.failureInventory.root ||
    report.verifier?.artifactDigest !== cut.verifier.artifactDigest
  ) {
    throw new Error("kfd-agent-hub-source-cut-mismatch: report profile, protocol, suite, or failure inventory differs from the resolved KFD package");
  }
  if (report.adapter?.artifactDigest !== sha256(fs.readFileSync(declaration.adapter.path))) {
    throw new Error("kfd-agent-hub-adapter-artifact-digest-mismatch: report does not bind the declared adapter artifact");
  }
  if (report.adapter?.id !== declaration.adapter.id || report.adapter?.version !== declaration.adapter.version) {
    throw new Error("kfd-agent-hub-adapter-identity-mismatch: report adapter identity differs from the declaration");
  }
  const capabilities = Array.isArray(report.capabilities) ? report.capabilities : [];
  if (capabilities.length < 2) throw new Error("kfd-agent-hub-report-invalid: at least two Hub capability documents are required");
  const documents = capabilities.map((entry) => entry.document || {});
  for (const document of documents) {
    assertSameSet(declaration.capabilities.operations, document.operations || [], "operations");
    assertSameSet(declaration.capabilities.topologies, document.topologies || [], "topologies");
    assertSameSet(declaration.capabilities.hubBindings, (document.bindings || []).map((binding) => binding.id), "Hub bindings");
  }
}

function adoptionLock({ cwd, declaration, cut }) {
  const lock = {
    schemaVersion: 1,
    contract: KFD_AGENT_HUB_LOCK_CONTRACT,
    declaration: {
      path: relative(cwd, declaration.path),
      digest: sha256(fs.readFileSync(declaration.path)),
    },
    adapter: {
      id: declaration.adapter.id,
      version: declaration.adapter.version,
      path: relative(cwd, declaration.adapter.path),
      artifactDigest: fs.existsSync(declaration.adapter.path) ? sha256(fs.readFileSync(declaration.adapter.path)) : "",
      invocationBinding: cut.binding,
    },
    sourceCut: cut,
    capabilities: declaration.capabilities,
  };
  return { ...lock, lockRoot: sha256(stableJson(lock)) };
}

export function initKfdAgentHub({ cwd = process.cwd(), declarationPath = KFD_AGENT_HUB_DECLARATION, write = false, force = false } = {}) {
  const filePath = path.resolve(cwd, declarationPath);
  const declaration = {
    $schema: "https://buildchain.libkungfu.dev/schemas/kfd-agent-hub-adoption.schema.json",
    schemaVersion: 1,
    contract: KFD_AGENT_HUB_ADOPTION_CONTRACT,
    profile: { package: "@kungfu-tech/kfd", id: "kfd-agent-hub-conformance" },
    adapter: { id: "replace-with-adapter-id", version: "0.1.0", path: "dist/agent-hub-adapter.mjs" },
    capabilities: {
      operations: ["capability-advertisement", "responsibility-proposal", "fact-admission", "supersession", "completion-assessment", "warrant-revocation"],
      topologies: ["local-peer"],
      hubBindings: ["local-file-bundle"],
    },
  };
  if (write) {
    if (fs.existsSync(filePath) && !force) throw new Error(`kfd-agent-hub-declaration-exists: ${relative(cwd, filePath)}; use --force to replace it`);
    writeJson(filePath, declaration);
  }
  return { schemaVersion: 1, contract: "kungfu-buildchain-kfd-agent-hub-init/v1", path: relative(cwd, filePath), write, declaration };
}

export function inspectKfdAgentHub({ cwd = process.cwd(), declarationPath = KFD_AGENT_HUB_DECLARATION, kfdRoot = "" } = {}) {
  const declaration = loadDeclaration({ cwd, declarationPath });
  const kfd = resolveKfdPackage({ cwd, kfdRoot });
  const cut = inspectKfdCut(kfd);
  const lock = adoptionLock({ cwd, declaration, cut });
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-kfd-agent-hub-inspection/v1",
    valid: Boolean(lock.adapter.artifactDigest),
    declaration: declaration.value,
    lock,
    issues: lock.adapter.artifactDigest ? [] : [{ code: "adapter-artifact-missing", path: lock.adapter.path }],
  };
}

export function testKfdAgentHub({ cwd = process.cwd(), declarationPath = KFD_AGENT_HUB_DECLARATION, outputDir = KFD_AGENT_HUB_OUTPUT_DIR, kfdRoot = "", run = defaultRun } = {}) {
  const declaration = loadDeclaration({ cwd, declarationPath });
  if (declaration.adapter.build.length) {
    runChecked(run, declaration.adapter.build[0], declaration.adapter.build.slice(1), { cwd }, "kfd-agent-hub-adapter-build-failed");
  }
  if (!fs.existsSync(declaration.adapter.path)) {
    throw new Error(`kfd-agent-hub-adapter-missing: ${relative(cwd, declaration.adapter.path)}`);
  }
  const kfd = resolveKfdPackage({ cwd, kfdRoot });
  const cut = inspectKfdCut(kfd);
  const absoluteOutputDir = path.resolve(cwd, outputDir);
  const reportPath = path.join(absoluteOutputDir, "report.json");
  fs.mkdirSync(absoluteOutputDir, { recursive: true });
  const candidateReportPath = path.join(absoluteOutputDir, `.report-${crypto.randomUUID()}.json`);
  let report;
  let verifier;
  try {
    runChecked(run, process.execPath, [kfd.binPath, "test", "agent-hub", "--adapter", declaration.adapter.path, ...declaration.adapter.args.flatMap((arg) => ["--adapter-arg", arg]), "--output", candidateReportPath], { cwd }, "kfd-agent-hub-suite-failed");
    const verifyResult = runChecked(run, process.execPath, [kfd.binPath, "verify", "agent-hub-report", candidateReportPath, "--adapter", declaration.adapter.path, "--json"], { cwd }, "kfd-agent-hub-report-verification-failed");
    report = readJson(candidateReportPath, "KFD Agent Hub report");
    verifier = JSON.parse(verifyResult.stdout);
    if (verifier.contract !== "kfd.agent-hub-report-verifier/v1" || verifier.valid !== true) {
      throw new Error("kfd-agent-hub-report-verification-failed: verifier did not return a valid report verdict");
    }
    if (verifier.reportDigest !== semanticRoot(report)) {
      throw new Error("kfd-agent-hub-report-verification-failed: verifier report digest does not match report semantics");
    }
    validateReport(report, declaration, cut);
    writeJson(reportPath, report);
  } finally {
    if (fs.existsSync(candidateReportPath)) fs.unlinkSync(candidateReportPath);
  }
  const lock = adoptionLock({ cwd, declaration, cut });
  const verification = {
    schemaVersion: 1,
    contract: KFD_AGENT_HUB_VERIFICATION_CONTRACT,
    valid: true,
    declarationDigest: lock.declaration.digest,
    lockRoot: lock.lockRoot,
    reportDigest: verifier.reportDigest,
    verifier,
    claimBoundary: cut.claimBoundary,
    residualRisk: report.residualRisk,
  };
  writeJson(path.join(absoluteOutputDir, "adoption-lock.json"), lock);
  writeJson(path.join(absoluteOutputDir, "verification.json"), verification);
  writeJson(path.join(absoluteOutputDir, "evidence.json"), {
    schemaVersion: 1,
    contract: "kungfu-buildchain-kfd-agent-hub-evidence/v1",
    report: { path: "report.json", digest: verification.reportDigest },
    verification: { path: "verification.json", contract: verification.contract, valid: true },
    lock: { path: "adoption-lock.json", root: lock.lockRoot },
    kfd: {
      package: cut.package,
      profile: cut.profile,
      protocol: cut.protocol,
      suite: cut.suite,
      failureInventory: cut.failureInventory,
    },
    scope: {
      adapterArtifactDigest: lock.adapter.artifactDigest,
      invocationBinding: lock.adapter.invocationBinding,
      capabilities: lock.capabilities,
    },
    qualifying: false,
    certification: false,
    claimBoundary: cut.claimBoundary,
  });
  return { schemaVersion: 1, contract: "kungfu-buildchain-kfd-agent-hub-test/v1", valid: true, outputDir: relative(cwd, absoluteOutputDir), lock, report, verification };
}

export function explainKfdAgentHub({ cwd = process.cwd(), declarationPath = KFD_AGENT_HUB_DECLARATION, kfdRoot = "" } = {}) {
  try {
    const result = inspectKfdAgentHub({ cwd, declarationPath, kfdRoot });
    return {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-agent-hub-explanation/v1",
      status: result.valid ? "ready" : "blocked",
      layer: result.valid ? "kfd-agent-hub" : "adapter-artifact",
      owner: result.valid ? "KFD runner and declared adapter" : "consumer adapter",
      evidencePath: result.valid ? KFD_AGENT_HUB_OUTPUT_DIR : result.lock.adapter.path,
      nextAction: result.valid ? "run buildchain kfd hub test --for agent" : `produce ${result.lock.adapter.path}`,
      lockRoot: result.lock.lockRoot,
    };
  } catch (error) {
    const message = String(error.message || error);
    const [code] = message.split(":", 1);
    return {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-agent-hub-explanation/v1",
      status: "blocked",
      layer: code,
      owner: code.includes("package") || code.includes("profile") ? "KFD package" : "consumer declaration",
      evidencePath: declarationPath,
      nextAction: message,
    };
  }
}
