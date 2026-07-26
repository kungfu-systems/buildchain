#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_CONTRACT = "buildchain.macos-credential-island-evidence/v1";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function filesBelow(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(item);
      else if (entry.isFile()) result.push(item);
    }
  };
  visit(path.resolve(root));
  return result.sort();
}

function oneNamed(root, name) {
  const matches = filesBelow(root).filter(
    (item) => path.basename(item) === name,
  );
  if (matches.length !== 1) {
    throw new Error(
      `${root} must contain exactly one ${name}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeManifestFile(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, String(relativePath || ""));
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`manifest path escapes payload root: ${relativePath}`);
  }
  return resolved;
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

export function verifyCredentialIslandSelfDogfood({
  jobResult,
  payloadRoot,
  manifestRoot,
  expectedRepository,
  expectedSourceSha,
  expectedRuntimeSha,
  expectedArtifactName,
  expectedManifestArtifactName,
}) {
  const failures = [];
  const observed = {
    jobResult: String(jobResult || ""),
    payloadArtifact: String(expectedArtifactName || ""),
    manifestArtifact: String(expectedManifestArtifactName || ""),
    repository: "",
    sourceSha: "",
    sourceTreeSha: "",
    runtimeSha: "",
    artifactName: "",
    platform: null,
    identity: null,
    notarization: null,
    verification: null,
    fileCount: 0,
    manifestSha256: "",
  };

  check(
    jobResult === "success",
    `credential-island job result is ${jobResult || "missing"}`,
    failures,
  );
  check(
    Boolean(expectedArtifactName),
    "signed payload artifact name is missing",
    failures,
  );
  check(
    Boolean(expectedManifestArtifactName),
    "signed manifest artifact name is missing",
    failures,
  );

  try {
    const payloadManifestPath = oneNamed(payloadRoot, "manifest.json");
    const authoritativeManifestPath = oneNamed(manifestRoot, "manifest.json");
    const evidencePath = oneNamed(
      payloadRoot,
      "credential-island-evidence.json",
    );
    const payloadManifestBytes = fs.readFileSync(payloadManifestPath);
    const authoritativeManifestBytes = fs.readFileSync(
      authoritativeManifestPath,
    );
    observed.manifestSha256 = sha256File(payloadManifestPath);
    check(
      payloadManifestBytes.equals(authoritativeManifestBytes),
      "authoritative manifest artifact does not byte-match the payload manifest",
      failures,
    );

    const manifest = readJson(payloadManifestPath);
    const evidence = readJson(evidencePath);
    observed.repository = String(evidence?.source?.repository || "");
    observed.sourceSha = String(evidence?.source?.sha || "");
    observed.sourceTreeSha = String(evidence?.source?.treeSha || "");
    observed.runtimeSha = String(evidence?.buildchain?.runtimeSha || "");
    observed.artifactName = String(manifest?.artifactName || "");
    observed.platform = manifest?.platform || null;
    observed.identity = evidence?.identity || null;
    observed.notarization = evidence?.notarization || null;
    observed.verification = evidence?.verification || null;
    observed.fileCount = Array.isArray(manifest?.files)
      ? manifest.files.length
      : 0;

    check(
      evidence?.schema === EVIDENCE_CONTRACT,
      "credential evidence contract mismatch",
      failures,
    );
    check(
      evidence?.status === "accepted",
      "credential evidence status is not accepted",
      failures,
    );
    check(
      observed.repository === expectedRepository,
      "credential evidence repository mismatch",
      failures,
    );
    check(
      SHA_PATTERN.test(observed.sourceSha),
      "credential evidence source SHA is invalid",
      failures,
    );
    check(
      observed.sourceSha === expectedSourceSha,
      "credential evidence source SHA mismatch",
      failures,
    );
    check(
      SHA_PATTERN.test(observed.sourceTreeSha),
      "credential evidence source tree SHA is invalid",
      failures,
    );
    check(
      SHA_PATTERN.test(observed.runtimeSha),
      "credential evidence runtime SHA is invalid",
      failures,
    );
    check(
      observed.runtimeSha === expectedRuntimeSha,
      "credential evidence runtime SHA mismatch",
      failures,
    );
    check(
      evidence?.runner?.os === "darwin",
      "credential evidence runner is not macOS",
      failures,
    );
    check(
      ["arm64", "x64"].includes(evidence?.runner?.arch) &&
        evidence?.runner?.arch === evidence?.app?.architecture,
      "credential evidence architecture is inconsistent",
      failures,
    );
    check(
      /^[0-9a-f]{40}$/iu.test(
        String(evidence?.identity?.certificateSha1 || ""),
      ),
      "Developer ID certificate SHA-1 is invalid",
      failures,
    );
    check(
      String(evidence?.identity?.certificateSubject || "").startsWith(
        "Developer ID Application:",
      ),
      "Developer ID certificate subject is invalid",
      failures,
    );
    check(
      /^[A-Z0-9]{10}$/u.test(String(evidence?.identity?.teamId || "")),
      "Developer ID team identifier is invalid",
      failures,
    );
    for (const [label, notarization] of Object.entries({
      application: evidence?.notarization?.application,
      diskImage: evidence?.notarization?.diskImage,
    })) {
      check(
        notarization?.status === "Accepted",
        `${label} notarization was not accepted`,
        failures,
      );
      check(
        UUID_PATTERN.test(String(notarization?.id || "")),
        `${label} notarization id is invalid`,
        failures,
      );
    }
    for (const name of [
      "codesignStrict",
      "hardenedRuntime",
      "appStaple",
      "appGatekeeper",
      "dmgStaple",
      "dmgGatekeeper",
    ]) {
      check(
        evidence?.verification?.[name] === true,
        `${name} verification is not true`,
        failures,
      );
    }

    check(
      manifest?.contract === "kungfu-buildchain-artifact",
      "credential manifest contract mismatch",
      failures,
    );
    check(
      manifest?.lifecycle?.stage === "credential-island",
      "credential manifest lifecycle mismatch",
      failures,
    );
    check(
      manifest?.expectedArtifacts?.ok === true,
      "credential manifest did not qualify",
      failures,
    );
    check(
      manifest?.expectedArtifacts?.source === EVIDENCE_CONTRACT,
      "credential manifest evidence source mismatch",
      failures,
    );
    check(
      manifest?.git?.repository === expectedRepository,
      "credential manifest repository mismatch",
      failures,
    );
    check(
      manifest?.git?.sha === expectedSourceSha,
      "credential manifest source SHA mismatch",
      failures,
    );
    check(
      manifest?.artifactName === expectedArtifactName,
      "credential manifest artifact name mismatch",
      failures,
    );
    check(
      manifest?.platform?.os === "macos",
      "credential manifest platform is not macOS",
      failures,
    );
    check(
      manifest?.platform?.arch === evidence?.app?.architecture,
      "credential manifest architecture mismatch",
      failures,
    );

    const manifestFiles = Array.isArray(manifest?.files) ? manifest.files : [];
    check(
      manifestFiles.length === 3,
      `credential manifest file count is ${manifestFiles.length}, expected 3`,
      failures,
    );
    const extensions = new Set(
      manifestFiles.map((item) => path.extname(String(item.path || ""))),
    );
    check(extensions.has(".dmg"), "credential manifest has no DMG", failures);
    check(extensions.has(".zip"), "credential manifest has no ZIP", failures);
    check(
      manifestFiles.some(
        (item) =>
          path.basename(String(item.path || "")) ===
          "credential-island-evidence.json",
      ),
      "credential manifest has no retained credential evidence",
      failures,
    );
    for (const file of manifestFiles) {
      const filePath = safeManifestFile(payloadRoot, file.path);
      check(
        fs.existsSync(filePath),
        `credential payload is missing ${file.path}`,
        failures,
      );
      if (!fs.existsSync(filePath)) continue;
      const size = fs.statSync(filePath).size;
      const digest = sha256File(filePath);
      check(
        size === file.size,
        `credential payload size mismatch for ${file.path}`,
        failures,
      );
      check(
        SHA256_PATTERN.test(String(file.sha256 || "")),
        `credential manifest SHA-256 is invalid for ${file.path}`,
        failures,
      );
      check(
        digest === file.sha256,
        `credential payload SHA-256 mismatch for ${file.path}`,
        failures,
      );
    }

    const evidenceArtifacts = Array.isArray(evidence?.artifacts)
      ? evidence.artifacts
      : [];
    check(
      evidenceArtifacts.length === 2,
      "credential evidence must retain exactly DMG and ZIP digests",
      failures,
    );
    for (const item of evidenceArtifacts) {
      const manifestFile = manifestFiles.find(
        (file) => path.basename(String(file.path || "")) === item.name,
      );
      check(
        Boolean(manifestFile),
        `credential evidence artifact ${item.name || "<missing>"} is absent from manifest`,
        failures,
      );
      if (!manifestFile) continue;
      check(
        item.bytes === manifestFile.size,
        `credential evidence size mismatch for ${item.name}`,
        failures,
      );
      check(
        item.sha256 === `sha256:${manifestFile.sha256}`,
        `credential evidence SHA-256 mismatch for ${item.name}`,
        failures,
      );
    }
  } catch (error) {
    failures.push(String(error?.message || error));
  }

  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-credential-island-self-dogfood/v1",
    checkedAt: new Date().toISOString(),
    status: failures.length === 0 ? "passed" : "failed",
    observed,
    failures,
  };
}

function requiredEnv(name) {
  return String(process.env[name] || "").trim();
}

function main() {
  const outputPath = path.resolve(
    requiredEnv("BUILDCHAIN_SELF_DOGFOOD_OUTPUT") ||
      ".buildchain/self-dogfood/credential-island.json",
  );
  const result = verifyCredentialIslandSelfDogfood({
    jobResult: requiredEnv("BUILDCHAIN_CREDENTIAL_JOB_RESULT"),
    payloadRoot: requiredEnv("BUILDCHAIN_CREDENTIAL_PAYLOAD_ROOT"),
    manifestRoot: requiredEnv("BUILDCHAIN_CREDENTIAL_MANIFEST_ROOT"),
    expectedRepository: requiredEnv("BUILDCHAIN_EXPECTED_REPOSITORY"),
    expectedSourceSha: requiredEnv("BUILDCHAIN_EXPECTED_SOURCE_SHA"),
    expectedRuntimeSha: requiredEnv("BUILDCHAIN_EXPECTED_RUNTIME_SHA"),
    expectedArtifactName: requiredEnv("BUILDCHAIN_EXPECTED_ARTIFACT_NAME"),
    expectedManifestArtifactName: requiredEnv(
      "BUILDCHAIN_EXPECTED_MANIFEST_ARTIFACT_NAME",
    ),
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `credential-island self-dogfood: ${result.status} (${result.failures.length} failure(s))\n`,
  );
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`::error::${failure}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
