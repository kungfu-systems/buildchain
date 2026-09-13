import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { createArtifactSigningRequest } from "../packages/core/build/artifact-signing.js";
import {
  resolveAuthorityDispatchRef,
} from "../packages/core/build/signing/dispatch.js";
import { finalizeNativeArtifactSigningResult } from "../packages/core/build/signing/native-result.js";
import { inspectArtifactSigningRequests } from "../packages/core/build/signing/intake.js";
import { importArtifactSigningResults } from "../packages/core/build/signing/import-results.js";
import { materializeArtifactSigningRequest } from "../packages/core/build/signing/materialize.js";
import { verifyArtifactSigningResults } from "../packages/core/build/signing/verify-results.js";

test("signing dispatch uses a public entry and leaves runtime selection to its input", () => {
  assert.equal(resolveAuthorityDispatchRef(), "v4");
  for (const entry of ["v4", "v4-alpha"]) assert.equal(resolveAuthorityDispatchRef(entry), entry);
  for (const invalid of ["v3", "4".repeat(40), "train/v4/v4.1/repair", "authority/v4/v4.1/artifact-signing"])
    assert.throws(() => resolveAuthorityDispatchRef(invalid), /public floating channel/);
});

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function fixture({ platform = "windows", kind = "pe", signature = {} } = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-native-signing-"),
  );
  const input = path.join(root, "input");
  const item = path.join(input, "agent");
  fs.mkdirSync(item, { recursive: true });
  const payload = Buffer.from("unsigned-native-binary\n");
  fs.writeFileSync(path.join(item, "agent.exe"), payload);
  const request = createArtifactSigningRequest({
    source: {
      repository: "kungfu-systems/sample-consumer",
      sha: "1".repeat(40),
      treeSha: "2".repeat(40),
    },
    runtime: { sha: "3".repeat(40) },
    artifact: {
      id: "sample-consumer",
      path: "dist/agent.exe",
      platform,
      kind,
      bytes: payload.length,
      digest: digest(payload),
      transport: {
        file: "agent/agent.exe",
        format: "exact-file",
        bytes: payload.length,
        digest: digest(payload),
      },
    },
    signature,
  });
  fs.writeFileSync(
    path.join(item, "request.json"),
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
            path: "agent/request.json",
            required: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { root, input, request, payload };
}

test("native authority materializes only the sealed PE and binds final signed bytes", () => {
  const value = fixture();
  try {
    const work = path.join(value.root, "work", "signed.exe");
    materializeArtifactSigningRequest({
      requestRoot: value.input,
      requestPath: "agent/request.json",
      expectedProfile: "windows-authenticode",
      outputPath: work,
    });
    assert.deepEqual(fs.readFileSync(work), value.payload);
    fs.appendFileSync(work, "authenticode-signature");
    const evidencePath = path.join(value.root, "work", "evidence.json");
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify({
        contract: "kungfu-buildchain-windows-authenticode-evidence/v1",
        status: "passed",
        provider: "microsoft-authenticode",
        checks: ["signtool-policy", "rfc3161-timestamp"],
      })}\n`,
    );
    const output = path.join(value.root, "output");
    const index = finalizeNativeArtifactSigningResult({
      requestRoot: value.input,
      requestPath: "agent/request.json",
      signedPayload: work,
      evidencePath,
      outputRoot: output,
      checks: "signtool-policy,rfc3161-timestamp,publisher-fingerprint",
    });
    assert.equal(index.results.length, 1);
    assert.equal(
      verifyArtifactSigningResults({
        requestRoot: value.input,
        resultRoot: output,
      }).ok,
      true,
    );
    const nestedIntake = path.join(
      value.root,
      "nested-intake",
      "request-artifact",
    );
    fs.cpSync(value.input, nestedIntake, { recursive: true });
    assert.equal(
      verifyArtifactSigningResults({
        requestRoot: path.dirname(nestedIntake),
        resultRoot: output,
      }).ok,
      true,
    );
    const consumer = path.join(value.root, "consumer");
    fs.mkdirSync(path.join(consumer, "dist"), { recursive: true });
    fs.writeFileSync(path.join(consumer, "dist", "agent.exe"), value.payload);
    const imported = importArtifactSigningResults({
      workspace: consumer,
      cwd: ".",
      requestRoot: value.input,
      resultRoot: output,
      evidenceRoot: ".buildchain/artifacts/signing/windows-x64",
    });
    assert.equal(imported.imported.length, 1);
    assert.deepEqual(
      fs.readFileSync(path.join(consumer, "dist", "agent.exe")),
      fs.readFileSync(work),
    );
    fs.appendFileSync(path.join(output, index.results[0].payload), "tamper");
    assert.throws(
      () =>
        verifyArtifactSigningResults({
          requestRoot: value.input,
          resultRoot: output,
        }),
      /result payload byte count mismatch|result payload digest mismatch/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("authority intake routes native profiles without accepting source substitution", () => {
  const value = fixture();
  try {
    const matrices = inspectArtifactSigningRequests({
      inputRoot: value.input,
      expectedRepository: "kungfu-systems/sample-consumer",
    });
    assert.equal(matrices.windows.length, 1);
    assert.equal(matrices.macos.length, 0);
    assert.equal(matrices.detached.length, 0);
    assert.equal(matrices.windows[0].platformId, "windows");
    assert.equal(matrices.windows[0].sourceSha, "1".repeat(40));
    assert.equal(matrices.windows[0].entitlementsProfile, "none");
    assert.throws(
      () =>
        inspectArtifactSigningRequests({
          inputRoot: value.input,
          expectedRepository: "other/repository",
        }),
      /source repository mismatch/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("authority intake carries sealed JIT profile intent into the macOS matrix", () => {
  const value = fixture({
    platform: "macos",
    kind: "archive",
    signature: {
      profile: "apple-developer-id",
      entitlementsProfile: "jit-executable-v1",
      entitlementsPaths: ["runtime/python/bin/python3"],
    },
  });
  try {
    const matrices = inspectArtifactSigningRequests({
      inputRoot: value.input,
      expectedRepository: "kungfu-systems/sample-consumer",
    });
    assert.equal(matrices.macos.length, 1);
    assert.equal(matrices.macos[0].entitlementsProfile, "jit-executable-v1");
    assert.equal(
      matrices.macos[0].entitlementsPaths,
      "runtime/python/bin/python3",
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("native authority binds and projects a notarized app release payload", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-native-app-signing-"),
  );
  try {
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
          input: { requestDigest: request.digest },
          app: { architecture: "arm64" },
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
            dmgStaple: true,
            dmgGatekeeper: true,
          },
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

    const output = path.join(root, "output");
    finalizeNativeArtifactSigningResult({
      requestRoot: input,
      requestPath: "app/request.json",
      signedPayload: zip,
      evidencePath,
      credentialArtifactRoot: credential,
      outputRoot: output,
      expectedRunId: "1000",
      expectedRunAttempt: "2",
    });
    assert.equal(
      verifyArtifactSigningResults({ requestRoot: input, resultRoot: output })
        .ok,
      true,
    );
    assert.throws(
      () =>
        finalizeNativeArtifactSigningResult({
          requestRoot: input,
          requestPath: "app/request.json",
          signedPayload: zip,
          evidencePath,
          credentialArtifactRoot: credential,
          outputRoot: path.join(root, "cross-run-output"),
          expectedRunId: "1001",
          expectedRunAttempt: "2",
        }),
      /does not prove the requested native signature/u,
    );

    const consumer = path.join(root, "consumer");
    fs.mkdirSync(path.join(consumer, "product", "release"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(consumer, "product", "release", "existing.txt"),
      "existing",
    );
    const imported = importArtifactSigningResults({
      workspace: consumer,
      requestRoot: input,
      resultRoot: output,
      evidenceRoot: ".buildchain/artifacts/signing/macos-arm64",
    });
    assert.equal(imported.credentialArtifacts.length, 1);
    assert.equal(
      fs.readFileSync(
        path.join(consumer, "product", "release", path.basename(dmg)),
        "utf8",
      ),
      "signed-stapled-dmg",
    );
    fs.appendFileSync(
      path.join(
        output,
        "credential-artifact",
        "product",
        "release",
        path.basename(dmg),
      ),
      "tamper",
    );
    assert.throws(
      () =>
        verifyArtifactSigningResults({
          requestRoot: input,
          resultRoot: output,
        }),
      /result evidence digest mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Buildchain authority owns native credentials and performs provider verification", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const workflowText = fs.readFileSync(
    path.join(root, ".github/workflows/public-release-signing-authority.yml"),
    "utf8",
  );
  const workflow = workflowText.replace(/\n\s+/g, " ");
  const macosAction = fs.readFileSync(
    path.join(root, "actions/release/signing/macos/action.yml"),
    "utf8",
  );
  const deliveryAction = fs.readFileSync(
    path.join(root, "actions/release/signing/deliver/action.yml"),
    "utf8",
  );
  const releaseVerify = fs.readFileSync(
    path.join(root, ".github/workflows/self-build-channel-verify.yml"),
    "utf8",
  );
  const reusableDocs = fs.readFileSync(
    path.join(root, "docs/reusable-build-surface.md"),
    "utf8",
  );
  const macos = fs.readFileSync(
    path.join(
      root,
      "packages/core/providers/signing/macos/sign-request.sh",
    ),
    "utf8",
  );
  const windows = fs.readFileSync(
    path.join(
      root,
      "packages/core/providers/signing/windows/sign-request.ps1",
    ),
    "utf8",
  );
  assert.match(workflow, /environment: buildchain-artifact-signing/);
  assert.match(workflow, /source-run-attempt:[\s\S]*?required: true/);
  assert.match(workflow, /expected-request-root:[\s\S]*?required: true/);
  assert.match(
    workflow,
    /group: artifact-signing-\$\{\{ inputs\.source-repository \}\}-\$\{\{ inputs\.source-run-id \}\}-\$\{\{ inputs\.source-run-attempt \}\}-\$\{\{ inputs\.correlation-id \}\}/,
  );
  assert.match(
    workflowText,
    /macos:[\s\S]*?strategy:\n\s+fail-fast: false[\s\S]*?matrix:\n\s+request: \$\{\{ fromJSON\(needs\.intake\.outputs\.macos-matrix\) \}\}/,
  );
  assert.match(
    deliveryAction,
    /uses: \.\/\.buildchain\/runtime\/actions\/build\/signing\/qualify-delivery/,
  );
  assert.match(workflow, /runtime-ref:/);
  assert.match(
    reusableDocs,
    /public-release-signing-authority\.yml@v4/,
  );
  assert.match(workflow, /secrets\.BUILDCHAIN_MACOS_CERTIFICATE_P12_BASE64/);
  assert.match(workflow, /secrets\.BUILDCHAIN_MACOS_NOTARY_API_KEY_P8_BASE64/);
  assert.match(workflow, /team-id: \$\{\{ vars\.BUILDCHAIN_MACOS_EXPECTED_TEAM_ID \}\}/);
  assert.match(macosAction, /expected-team-id: \$\{\{ inputs\.team-id \}\}/);
  assert.doesNotMatch(workflow, /secrets\.BUILDCHAIN_APPLE_/);
  assert.match(workflow, /secrets\.BUILDCHAIN_WINDOWS_CERTIFICATE_PFX_BASE64/);
  assert.match(macos, /-T \/usr\/bin\/codesign -T \/usr\/bin\/security/);
  assert.match(macos, /set-key-partition-list -S apple-tool:,apple:,codesign:/);
  assert.doesNotMatch(macos, /set-key-partition-list[^\n]+ -s /);
  assert.match(macos, /list-keychains -d user -s "\$\{keychain_path\}"/);
  assert.match(macos, /Buildchain macOS authority: sign exact Mach-O payload/);
  assert.match(macos, /sign compound archive Mach-O payloads/);
  const nativeProvider = fs.readFileSync(path.join(root, "packages/core/providers/signing/native.js"), "utf8");
  assert.match(nativeProvider, /BUILDCHAIN_ARTIFACT_KIND: artifact.kind/);
  assert.match(nativeProvider, /BUILDCHAIN_ENTITLEMENTS_PROFILE:\s*signature.entitlementsProfile/);
  assert.match(nativeProvider, /BUILDCHAIN_ENTITLEMENTS_PATHS: \(signature.entitlementsPaths/);
  assert.match(macosAction, /uses: \.\/\.buildchain\/runtime\/actions\/build\/signing\/sign-macos/);
  assert.match(macos, /--entitlements-profile "\$\{entitlements_profile\}"/);
  assert.match(macos, /--entitlements-paths "\$\{entitlements_paths\}"/);
  assert.match(
    macosAction,
    /Developer ID sign, notarize, and staple Apple application[\s\S]*uses: \.\/\.buildchain\/runtime\/actions\/build\/credential\/macos-island/,
  );
  assert.match(macos, /codesign --verify --strict/);
  assert.match(macos, /notarytool submit/);
  assert.doesNotMatch(macos, /notarytool submit[^\n]+--wait/);
  assert.match(
    macos,
    /notarytool wait "\$\{notary_id\}"[^\n]+--timeout "\$\{notary_timeout\}"/,
  );
  assert.match(
    macos,
    /notarization submission \$\{notary_id\}; wait up to \$\{notary_timeout\}/,
  );
  assert.match(macos, /Apple accepted notarization \$\{notary_id\}/);
  assert.doesNotMatch(macos, /spctl --assess/);
  assert.match(macos, /standalone Mach-O executables do not support stapled/);
  assert.match(macos, /ticketDelivery: "online"/);
  assert.match(macos, /standalone-notary-ticket-online/);
  assert.match(macos, /compound-notary-ticket-online/);
  assert.doesNotMatch(workflow, /gatekeeper-execute/);
  assert.match(windows, /signtool verify \/pa \/all \/v/);
  assert.match(windows, /TimeStamperCertificate/);
  assert.match(windows, /SignatureStatus\]::Valid/);
});

test(
  "compound Apple archives sign outer and wheel Mach-O bytes and rebuild RECORD",
  {
    skip: process.platform === "win32",
  },
  () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-compound-signing-"),
    );
    try {
      const source = path.join(root, "source", "product");
      const wheelRoot = path.join(root, "wheel");
      fs.mkdirSync(path.join(source, "runtime"), { recursive: true });
      fs.mkdirSync(path.join(wheelRoot, "kungfu"), { recursive: true });
      fs.mkdirSync(path.join(wheelRoot, "kungfu-1.0.dist-info"), {
        recursive: true,
      });
      const magic = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]);
      const machO = (filetype, suffix) =>
        Buffer.concat([
          magic,
          Buffer.alloc(8),
          Buffer.from([0, 0, 0, filetype]),
          Buffer.from(suffix),
        ]);
      fs.writeFileSync(
        path.join(source, "runtime", "kungfu"),
        machO(2, "outer"),
      );
      fs.chmodSync(path.join(source, "runtime", "kungfu"), 0o755);
      fs.writeFileSync(
        path.join(wheelRoot, "kungfu", "native.so"),
        machO(6, "wheel"),
      );
      fs.writeFileSync(
        path.join(wheelRoot, "kungfu-1.0.dist-info", "RECORD"),
        "stale,sha256=stale,1\n",
      );
      const wheel = path.join(source, "runtime", "kungfu.whl");
      const zip = spawnSync(
        "python3",
        [
          "-c",
          "import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); out=sys.argv[2]; z=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(root).as_posix()) for p in sorted(root.rglob('*')) if p.is_file()]; z.close()",
          wheelRoot,
          wheel,
        ],
        { encoding: "utf8" },
      );
      assert.equal(zip.status, 0, zip.stderr);
      const archive = path.join(root, "product.tar.gz");
      const packed = spawnSync(
        "tar",
        ["-czf", archive, "-C", path.join(root, "source"), "product"],
        {
          encoding: "utf8",
          env: { ...process.env, COPYFILE_DISABLE: "1" },
        },
      );
      assert.equal(packed.status, 0, packed.stderr);
      const fake = path.join(root, "codesign");
      fs.writeFileSync(
        fake,
        `#!/bin/sh
if [ "$1" = "--display" ] && [ "$2" = "--entitlements" ]; then
  printf '%s\n' '<key>com.apple.security.cs.allow-jit</key>' >&2
  exit 0
fi
case "$1" in
  --display) printf '%s\\n' 'TeamIdentifier=RYNFD6L6DK' 'Runtime Version=15.0.0' 'Timestamp=Jul 29, 2026' >&2 ;;
  --verify) ;;
  *) for target do :; done; printf 'SIGNED' >> "$target" ;;
esac
`,
      );
      fs.chmodSync(fake, 0o755);
      const evidence = path.join(root, "evidence.json");
      const signed = spawnSync(
        "python3",
        [
          path.resolve(
            import.meta.dirname,
            "../packages/core/providers/signing/macos/compound-archive.py",
          ),
          "--archive",
          archive,
          "--work-root",
          path.join(root, "work"),
          "--notary-root",
          path.join(root, "notary"),
          "--evidence",
          evidence,
          "--identity",
          "certificate",
          "--keychain",
          "keychain",
          "--team-id",
          "RYNFD6L6DK",
          "--entitlements-profile",
          "jit-executable-v1",
          "--entitlements-paths",
          "product/runtime/kungfu",
          "--codesign",
          fake,
        ],
        { encoding: "utf8" },
      );
      assert.equal(signed.status, 0, signed.stderr);
      const proof = JSON.parse(fs.readFileSync(evidence, "utf8"));
      assert.equal(proof.machOCount, 1);
      assert.equal(proof.wheelCount, 1);
      assert.equal(proof.wheelMachOCount, 1);
      assert.equal(proof.entitlementsProfile, "jit-executable-v1");
      assert.equal(proof.entitledExecutableCount, 1);
      assert.deepEqual(proof.entitledPaths, ["product/runtime/kungfu"]);
      assert.match(proof.entitlementsSha256, /^sha256:[0-9a-f]{64}$/u);
      assert.ok(proof.checks.includes("jit-executable-entitlement"));
      const unpacked = path.join(root, "unpacked");
      fs.mkdirSync(unpacked);
      assert.equal(
        spawnSync("tar", ["-xzf", archive, "-C", unpacked]).status,
        0,
      );
      assert.match(
        fs
          .readFileSync(path.join(unpacked, "product", "runtime", "kungfu"))
          .toString("latin1"),
        /SIGNED/u,
      );
      const record = spawnSync(
        "python3",
        [
          "-c",
          "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read('kungfu-1.0.dist-info/RECORD').decode(), end='')",
          path.join(unpacked, "product", "runtime", "kungfu.whl"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(record.status, 0, record.stderr);
      assert.match(
        record.stdout,
        /kungfu\/native\.so,sha256=[A-Za-z0-9_-]{43},/u,
      );
      assert.doesNotMatch(record.stdout, /stale/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
