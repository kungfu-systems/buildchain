import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createArtifactSigningRequest } from "../../packages/core/build/artifact-signing.js";
const digest = (bytes) =>
  `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;

export function appSigningFixture(root) {
  const input = path.join(root, "input");
  const requestDirectory = path.join(input, "app");
  fs.mkdirSync(requestDirectory, { recursive: true });
  const unsignedTransport = path.join(requestDirectory, "subject.ditto.zip");
  fs.writeFileSync(unsignedTransport, "unsigned-app-transport");
  const request = createArtifactSigningRequest({
    source: {
      repository: "kungfu-systems/kungfu",
      sha: "1".repeat(40),
      treeSha: "2".repeat(40),
    },
    runtime: { sha: "3".repeat(40) },
    artifact: {
      id: "kungfu-app",
      path: "product/dist/desktop/mac-arm64/Kungfu Episodes.app",
      platform: "macos",
      arch: "arm64",
      kind: "app-bundle",
      bundleId: "io.kungfu.app",
      bytes: 42,
      digest: `sha256:${"4".repeat(64)}`,
      transport: {
        file: "app/subject.ditto.zip",
        format: "ditto-zip",
        bytes: fs.statSync(unsignedTransport).size,
        digest: digest(fs.readFileSync(unsignedTransport)),
      },
    },
  });
  fs.writeFileSync(
    path.join(requestDirectory, "request.json"),
    `${JSON.stringify(request, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(input, "index.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        contract: "kungfu-buildchain-artifact-signing-request-index/v1",
        requests: [
          {
            id: request.artifact.id,
            digest: request.digest,
            path: "app/request.json",
            required: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const credential = path.join(root, "credential");
  const release = path.join(credential, "product", "release");
  fs.mkdirSync(release, { recursive: true });
  const zip = path.join(
    release,
    "Kungfu-Episodes-4.0.0-alpha.1-macos-arm64.zip",
  );
  const dmg = path.join(
    release,
    "Kungfu-Episodes-4.0.0-alpha.1-macos-arm64.dmg",
  );
  const evidencePath = path.join(release, "credential-island-evidence.json");
  fs.writeFileSync(zip, "signed-stapled-app-zip");
  fs.writeFileSync(dmg, "signed-stapled-dmg");
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        schema: "buildchain.macos-credential-island-evidence/v1",
        status: "accepted",
        source: {
          repository: request.source.repository,
          sha: request.source.sha,
          treeSha: request.source.treeSha,
        },
        buildchain: { runtimeSha: request.runtime.sha },
        input: {
          requestDigest: request.digest,
          archiveSha256: request.artifact.transport.digest,
          archiveBytes: request.artifact.transport.bytes,
        },
        app: { architecture: "arm64", bundleId: "io.kungfu.app" },
        execution: {
          id: "e".repeat(64),
          runId: "1000",
          runAttempt: "2",
        },
        dmgAssembly: {
          schema: "buildchain.macos-dmg-assembly-evidence/v1",
          status: "accepted",
          executionId: "e".repeat(64),
          binding: {
            sourceSha: request.source.sha,
            runtimeSha: request.runtime.sha,
            requestDigest: request.digest,
            unsignedArchiveDigest: request.artifact.transport.digest,
            runId: "1000",
            runAttempt: "2",
          },
          policy: {
            maxAttempts: 3,
            retryableClassifications: ["resource-busy"],
            retryDelaysMs: [2000, 5000],
          },
          attempts: [
            {
              number: 1,
              outcome: "created",
              classification: "none",
            },
          ],
          cleanup: {
            ownership: "temporary-root-only",
            failedAttemptArtifactsRemoved: true,
            finalOwnedRoot: "removed",
          },
        },
        cleanup: { status: "complete" },
        toolchain: {
          node: process.version,
          macosProductVersion: "15.0",
          macosBuildVersion: "24A000",
          xcode: "Xcode 16.0; Build version 16A000",
        },
        notarization: {
          application: { id: "a", status: "Accepted" },
          diskImage: { id: "b", status: "Accepted" },
        },
        verification: {
          codesignStrict: true,
          hardenedRuntime: true,
          appStaple: true,
          appGatekeeper: true,
          dmgCodesign: true,
          dmgStaple: true,
          dmgGatekeeper: true,
        },
        artifacts: [zip, dmg].map((file) => ({
          kind: path.extname(file).slice(1),
          name: path.basename(file),
          bytes: fs.statSync(file).size,
          sha256: digest(fs.readFileSync(file)),
        })),
      },
      null,
      2,
    )}\n`,
  );
  const files = [zip, dmg, evidencePath].map((file) => ({
    path: path.relative(credential, file).split(path.sep).join("/"),
    size: fs.statSync(file).size,
    sha256: digest(fs.readFileSync(file)).slice("sha256:".length),
  }));
  fs.writeFileSync(
    path.join(credential, "manifest.json"),
    `${JSON.stringify({ files }, null, 2)}\n`,
  );

  return { input, zip, dmg, evidencePath, credential };
}
