import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveReleaseCandidateArtifacts } from "../scripts/release-candidate-resolver.mjs";

function createNpmTarball(root, packageJson) {
  const packageDir = path.join(root, "npm-source", "package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(packageJson)}\n`,
  );
  const tarballPath = path.join(root, "buildchain.tgz");
  execFileSync(
    "tar",
    [
      "-czf",
      path.basename(tarballPath),
      "-C",
      path.relative(root, path.dirname(packageDir)),
      "package",
    ],
    { cwd: root },
  );
  return tarballPath;
}

function createZipArchive(root, inputDir, filename) {
  const archivePath = path.join(root, filename);
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:BUILDCHAIN_TEST_ZIP_INPUT, $env:BUILDCHAIN_TEST_ZIP_OUTPUT)",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          BUILDCHAIN_TEST_ZIP_INPUT: inputDir,
          BUILDCHAIN_TEST_ZIP_OUTPUT: archivePath,
        },
      },
    );
    return archivePath;
  }
  const relativeArchivePath = path
    .relative(inputDir, archivePath)
    .split(path.sep)
    .join("/");
  execFileSync("zip", ["-q", "-r", relativeArchivePath, "."], {
    cwd: inputDir,
  });
  return archivePath;
}

function archiveMetadata(id, name, archivePath) {
  return {
    id,
    name,
    expired: false,
    size_in_bytes: fs.statSync(archivePath).size,
    digest: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex")}`,
  };
}

test("release candidate resolver seals downloaded npm bytes before deriving required artifacts", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-rc-download-seal-"),
  );
  try {
    const sourceSha = "7".repeat(40);
    const targetSha = "8".repeat(40);
    const version = "4.0.2-alpha.2";
    const artifactName = "buildchain";
    const passportInput = path.join(workspace, "passport-input");
    const summaryInput = path.join(workspace, "summary-input");
    const payloadInput = path.join(workspace, "payload-input");
    fs.mkdirSync(passportInput);
    fs.mkdirSync(summaryInput);
    fs.mkdirSync(payloadInput);
    fs.writeFileSync(
      path.join(passportInput, "release-candidate-passport.json"),
      `${JSON.stringify({
        repository: "kungfu-systems/buildchain",
        target: { version },
        source: { headSha: sourceSha, treeHash: "a".repeat(40) },
        buildchain: { sha: "9".repeat(40) },
        candidateHash: "b".repeat(64),
      })}\n`,
    );
    fs.writeFileSync(path.join(summaryInput, "build-summary.json"), "{}\n");
    fs.renameSync(
      createNpmTarball(workspace, { name: "@kungfu-tech/buildchain", version }),
      path.join(payloadInput, "buildchain.tgz"),
    );

    const passportArchive = createZipArchive(
      workspace,
      passportInput,
      "passport.zip",
    );
    const summaryArchive = createZipArchive(
      workspace,
      summaryInput,
      "summary.zip",
    );
    const payloadArchive = createZipArchive(
      workspace,
      payloadInput,
      "payload.zip",
    );
    const artifacts = [
      archiveMetadata(
        1,
        `${artifactName}-release-candidate-${sourceSha}`,
        passportArchive,
      ),
      archiveMetadata(
        2,
        `${artifactName}-summary-${sourceSha}`,
        summaryArchive,
      ),
      archiveMetadata(
        3,
        `${artifactName}-package-${sourceSha}`,
        payloadArchive,
      ),
    ];
    const archives = new Map([
      ["1", passportArchive],
      ["2", summaryArchive],
      ["3", payloadArchive],
    ]);
    const jsonResponse = (value) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
    });
    const fetchImpl = async (url) => {
      if (url.endsWith(`/commits/${targetSha}/pulls`)) {
        return jsonResponse([
          {
            number: 3314,
            state: "closed",
            merged_at: "2026-08-30T06:13:27Z",
            merge_commit_sha: targetSha,
            base: { ref: "alpha/v4/v4.0" },
            head: {
              ref: "fix/v4-protected-alpha-bootstrap-route",
              sha: sourceSha,
              repo: { full_name: "kungfu-systems/buildchain" },
            },
          },
        ]);
      }
      if (url.includes("actions/workflows/self-build-fixture.yml/runs")) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 42,
              name: "Build Surface Fixture",
              event: "pull_request",
              status: "completed",
              conclusion: "success",
              updated_at: "2026-08-30T06:12:00Z",
              pull_requests: [{ number: 3314 }],
            },
          ],
        });
      }
      if (url.includes("actions/runs/42/artifacts"))
        return jsonResponse({ artifacts });
      const artifactMatch = url.match(/artifacts\/(\d+)\/zip$/);
      if (artifactMatch) {
        const bytes = fs.readFileSync(archives.get(artifactMatch[1]));
        return {
          ok: true,
          status: 200,
          body: null,
          arrayBuffer: async () =>
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
        };
      }
      throw new Error(`unexpected url ${url}`);
    };
    const result = await resolveReleaseCandidateArtifacts({
      repository: "kungfu-systems/buildchain",
      targetRef: "alpha/v4/v4.0",
      targetSha,
      artifactName,
      artifactPatterns: `${artifactName}-package-*`,
      requiredArtifactCount: 1,
      publishArtifactKind: "npm",
      publishPackageMain: "@kungfu-tech/buildchain",
      outputDir: path.join(workspace, "resolved"),
      fetchImpl,
    });

    assert.equal(result.npmTarballCount, 1);
    assert.equal(
      result.publishRequiredArtifacts[0].name,
      "@kungfu-tech/buildchain",
    );
    assert.equal(result.publishRequiredArtifacts[0].ref, version);
    assert.equal(
      result.publishRequiredArtifacts[0].digest,
      result.publishRequiredArtifacts[0].integrity,
    );
    const sealedBundle = JSON.parse(
      fs.readFileSync(result.paths.sealedBundleManifest, "utf8"),
    );
    assert.equal(sealedBundle.npm.version, version);
    assert.equal(
      sealedBundle.npm.integrity,
      result.publishRequiredArtifacts[0].integrity,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
