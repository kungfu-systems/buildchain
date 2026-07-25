import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EVIDENCE_CONTRACT,
  INPUT_CONTRACT,
  assertContainedSymlinks,
  assertRealPathInside,
  cleanupState,
  createCredentialArtifactManifest,
  decodeBase64Secret,
  entitlementsForProfile,
  loadCredentialInput,
  parseIdentityListing,
  parseNotaryResult,
  safeArtifactName,
  safeArtifactStem,
  safePlatformId,
  sha256File,
} from "../actions/macos-credential-island/lib.js";

const SOURCE_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-credential-island-test-"),
  );
  const archive = path.join(root, "unsigned-app.zip");
  fs.writeFileSync(archive, "sealed-app");
  const manifest = {
    schema: INPUT_CONTRACT,
    source: {
      repository: "kungfu-systems/kungfu",
      sha: SOURCE_SHA,
      treeSha: TREE_SHA,
    },
    platform: { id: "macos-arm64", os: "macos", arch: "arm64" },
    app: {
      archivePath: "Kungfu Episodes.app",
      bundleId: "com.kungfu.app",
      productName: "Kungfu Episodes",
      version: "4.0.0-alpha.1",
    },
    archive: {
      file: path.basename(archive),
      format: "ditto-zip",
      bytes: fs.statSync(archive).size,
      sha256: sha256File(archive),
    },
  };
  fs.writeFileSync(
    path.join(root, "credential-input.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  return { root, archive, manifest };
}

test("credential input is source, tree, bundle, size, and digest bound", () => {
  const value = fixture();
  try {
    const loaded = loadCredentialInput(value.root, {
      repository: "kungfu-systems/kungfu",
      sourceSha: SOURCE_SHA,
      sourceTreeSha: TREE_SHA,
      bundleId: "com.kungfu.app",
    });
    assert.equal(loaded.manifest.schema, INPUT_CONTRACT);
    fs.appendFileSync(value.archive, "tamper");
    assert.throws(
      () =>
        loadCredentialInput(value.root, {
          repository: "kungfu-systems/kungfu",
          sourceSha: SOURCE_SHA,
          sourceTreeSha: TREE_SHA,
          bundleId: "com.kungfu.app",
        }),
      /digest mismatch/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("credential input rejects source and path substitution", () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        loadCredentialInput(value.root, {
          repository: "other/repository",
          sourceSha: SOURCE_SHA,
          sourceTreeSha: TREE_SHA,
          bundleId: "com.kungfu.app",
        }),
      /repository mismatch/,
    );
    value.manifest.archive.file = "../unsigned-app.zip";
    fs.writeFileSync(
      path.join(value.root, "credential-input.json"),
      `${JSON.stringify(value.manifest)}\n`,
    );
    assert.throws(() => loadCredentialInput(value.root), /parent traversal/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("base64 credential decoding is canonical and bounded", () => {
  assert.deepEqual(
    decodeBase64Secret(Buffer.from("credential").toString("base64"), "test"),
    Buffer.from("credential"),
  );
  assert.throws(
    () => decodeBase64Secret("not base64", "test"),
    /canonical base64/,
  );
  assert.throws(
    () =>
      decodeBase64Secret(Buffer.from("x").toString("base64"), "test", {
        minBytes: 2,
      }),
    /byte length/,
  );
});

test("identity and notarization parsing fail closed", () => {
  const identity = parseIdentityListing(
    `  1) ${"A".repeat(40)} "Developer ID Application: Example (ABCDE12345)"`,
    "A".repeat(40),
  );
  assert.equal(identity.sha1, "A".repeat(40));
  assert.throws(
    () =>
      parseIdentityListing(
        `  1) ${"A".repeat(40)} "Apple Development: Example"`,
        "A".repeat(40),
      ),
    /not a Developer ID Application/,
  );
  assert.deepEqual(
    parseNotaryResult(
      JSON.stringify({
        id: "11111111-2222-3333-4444-555555555555",
        status: "Accepted",
      }),
      "app",
    ),
    { id: "11111111-2222-3333-4444-555555555555", status: "Accepted" },
  );
  assert.throws(
    () =>
      parseNotaryResult(
        JSON.stringify({
          id: "11111111-2222-3333-4444-555555555555",
          status: "Invalid",
        }),
        "app",
      ),
    /not accepted/,
  );
});

test("entitlements and output names are Buildchain owned", () => {
  const profile = entitlementsForProfile("electron-desktop-v1");
  assert.match(profile.content, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(profile.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(safeArtifactStem("Kungfu Episodes"), "Kungfu-Episodes");
  assert.equal(
    safePlatformId("kungfu-macos-arm64-credential"),
    "kungfu-macos-arm64-credential",
  );
  assert.equal(
    safeArtifactName(`kungfu-macos-credential-${SOURCE_SHA}`),
    `kungfu-macos-credential-${SOURCE_SHA}`,
  );
  assert.throws(() => entitlementsForProfile("consumer-file"), /unsupported/);
  assert.throws(() => safeArtifactStem("../"), /unsafe/);
  assert.throws(() => safePlatformId("../macos"), /safe Buildchain/);
  assert.throws(() => safeArtifactName("macos/credential"), /safe Buildchain/);
});

test("signed payload manifest binds exact credential outputs", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-credential-manifest-"),
  );
  try {
    const release = path.join(root, "product", "release");
    fs.mkdirSync(release, { recursive: true });
    const files = [
      "Kungfu.dmg",
      "Kungfu.zip",
      "credential-island-evidence.json",
    ].map((name) => path.join(release, name));
    files.forEach((file, index) => fs.writeFileSync(file, `artifact-${index}`));
    const manifest = createCredentialArtifactManifest({
      artifactName: `kungfu-macos-credential-${SOURCE_SHA}`,
      platform: {
        id: "macos-arm64-credential",
        name: "macOS ARM64 credential island",
        arch: "arm64",
      },
      repository: "kungfu-systems/kungfu",
      sourceSha: SOURCE_SHA,
      sourceRef: "feature/example",
      artifactRoot: root,
      files,
    });
    assert.equal(manifest.contract, "kungfu-buildchain-artifact");
    assert.equal(manifest.expectedArtifacts.ok, true);
    assert.equal(manifest.files.length, 3);
    assert.ok(
      manifest.files.every(
        (file) =>
          file.path.startsWith("product/release/") &&
          /^[0-9a-f]{64}$/u.test(file.sha256),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "sealed app symlinks cannot escape the bundle",
  { skip: process.platform === "win32" },
  () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-credential-symlink-"),
    );
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-credential-outside-"),
    );
    try {
      fs.mkdirSync(path.join(root, "Contents"));
      const outsideLink = path.relative(path.join(root, "Contents"), outside);
      fs.symlinkSync(outsideLink, path.join(root, "Contents", "escape"));
      assert.throws(
        () => assertContainedSymlinks(root),
        /outside the app bundle/,
      );
      fs.rmSync(path.join(root, "Contents", "escape"));
      fs.symlinkSync(outsideLink, path.join(root, "Contents", "indirect"));
      fs.symlinkSync("indirect", path.join(root, "Contents", "escape"));
      assert.throws(
        () => assertContainedSymlinks(root),
        /outside the app bundle/,
      );
      const outsideFile = path.join(outside, "archive.zip");
      fs.writeFileSync(outsideFile, "outside");
      const linkedArchive = path.join(root, "archive.zip");
      fs.symlinkSync(outsideFile, linkedArchive);
      assert.throws(
        () => assertRealPathInside(root, linkedArchive, "archive"),
        /outside its declared root/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  },
);

test("cleanup restores search list and removes temporary material", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-credential-cleanup-"),
  );
  const keychain = path.join(root, "signing.keychain-db");
  fs.writeFileSync(keychain, "keychain");
  const calls = [];
  const errors = cleanupState(
    {
      temporaryRoot: root,
      temporaryKeychain: keychain,
      originalKeychains: ["/tmp/login.keychain-db"],
    },
    (args) => {
      calls.push(args);
      if (args[0] === "delete-keychain") fs.rmSync(keychain, { force: true });
    },
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(calls[0], [
    "list-keychains",
    "-d",
    "user",
    "-s",
    "/tmp/login.keychain-db",
  ]);
  assert.equal(fs.existsSync(root), false);
});

test("credential island bundle loads before validating runner inputs", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const bundlePath = path.join(
    root,
    "actions/macos-credential-island/dist/index.js",
  );
  const bundle = fs.readFileSync(bundlePath, "utf8");
  const result = spawnSync(
    process.execPath,
    [bundlePath],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
      },
    },
  );
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.status, 1);
  assert.match(
    output,
    /macOS credential island requires a macOS runner|Input required and not supplied: source-repository/u,
  );
  assert.doesNotMatch(output, /ReferenceError: module is not defined/u);
  assert.doesNotMatch(bundle, /\b__dirname\b/u);
});

test("public action and workflow keep credentials outside the build matrix", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const action = fs.readFileSync(
    path.join(root, "actions/macos-credential-island/action.yml"),
    "utf8",
  );
  const implementation = fs.readFileSync(
    path.join(root, "actions/macos-credential-island/index.js"),
    "utf8",
  );
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.build.yml"),
    "utf8",
  );
  const publicWorkflow = fs.readFileSync(
    path.join(root, ".github/workflows/build.yml"),
    "utf8",
  );
  const fixtureWorkflow = fs.readFileSync(
    path.join(root, ".github/workflows/build-surface-fixture.yml"),
    "utf8",
  );
  const nativeBuildJob = workflow.match(
    /\n  build-native:[\s\S]+?(?=\n  build-linux-container:)/u,
  )?.[0];
  const containerBuildJob = workflow.match(
    /\n  build-linux-container:[\s\S]+?(?=\n  relay-artifacts:)/u,
  )?.[0];
  assert.ok(nativeBuildJob);
  assert.ok(containerBuildJob);
  assert.match(action, /post: "dist\/cleanup\.js"/);
  assert.match(action, /certificate-p12-base64/);
  for (const label of [
    "create temporary keychain",
    "unlock temporary keychain",
    "import Developer ID PKCS#12",
    "configure Developer ID key access",
  ]) {
    assert.match(implementation, new RegExp(`failureLabel: "${label}"`, "u"));
  }
  for (const caller of [workflow, publicWorkflow, fixtureWorkflow]) {
    assert.match(caller, /permissions:\n  actions: read\n  contents: read/);
  }
  assert.match(
    publicWorkflow,
    /credential-island-macos-artifact:\n\s+description:[^\n]+\n\s+value: \$\{\{ jobs\.build\.outputs\.credential-island-macos-artifact \}\}/,
  );
  assert.match(
    publicWorkflow,
    /credential-island-macos-manifest-artifact:\n\s+description:[^\n]+\n\s+value: \$\{\{ jobs\.build\.outputs\.credential-island-macos-manifest-artifact \}\}/,
  );
  assert.match(
    publicWorkflow,
    /\n  build:\n[\s\S]*?uses: \.\/\.github\/workflows\/\.build\.yml\n\s+permissions:\n\s+actions: read\n\s+contents: read/,
  );
  for (const buildJob of [nativeBuildJob, containerBuildJob]) {
    assert.doesNotMatch(
      buildJob,
      /certificate-p12-base64|notary-api-key-p8-base64|BUILDCHAIN_MACOS_CERTIFICATE|BUILDCHAIN_MACOS_NOTARY/,
    );
  }
  assert.match(workflow, /Seal macOS credential-island input/);
  assert.match(
    workflow,
    /credential-island-caller-owned:\n\s+description:[^\n]+\n\s+default: false\n\s+type: boolean/,
  );
  assert.match(
    workflow,
    /CSC_IDENTITY_AUTO_DISCOVERY: \$\{\{ inputs\.credential-island-macos-app-path != '' && 'false' \|\| '' \}\}/,
  );
  assert.match(
    workflow,
    /Upload macOS credential-island runtime[\s\S]*?if: \$\{\{ inputs\.credential-island-macos-app-path != '' \}\}/,
  );
  assert.match(
    workflow,
    /caller-owned credential-island signing must bind its environment in the caller workflow/,
  );
  assert.match(
    workflow,
    /credential-island-input-manifest-\$\{\{ matrix\.platform\.id \}\}/,
  );
  assert.match(
    workflow,
    /Upload macOS credential-island app archive[\s\S]*?needs\.artifact-transfer\.outputs\.mode == 'github-artifacts'[\s\S]*?path: \.buildchain\/credential-island\/\$\{\{ matrix\.platform\.id \}\}\/unsigned-app\.zip[\s\S]*?archive: false/,
  );
  assert.match(
    workflow,
    /Upload macOS credential-island input manifest[\s\S]*?credential-island-input-manifest-\$\{\{ matrix\.platform\.id \}\}/,
  );
  assert.match(
    workflow,
    /Download source-bound sealed application archive[\s\S]*?name: unsigned-app\.zip[\s\S]*?Download source-bound sealed application manifest/,
  );
  assert.match(
    nativeBuildJob,
    /BUILDCHAIN_ARTIFACT_RELAY_CREDENTIAL_INPUT_PATHS:[\s\S]*?\.buildchain\/credential-island\/\{0\}/,
  );
  assert.match(
    workflow,
    /Upload relayed macOS credential-island input[\s\S]*?steps\.relay-download\.outputs\.credential-input-path/,
  );
  const credentialJob = workflow.match(
    /\n  credential-island-macos:[\s\S]+?(?=\n  summarize:)/u,
  )?.[0];
  assert.ok(credentialJob);
  assert.match(
    credentialJob,
    /always\(\)[\s\S]*?!inputs\.credential-island-caller-owned[\s\S]*?needs\.artifact-transfer\.outputs\.mode == 'github-artifacts'[\s\S]*?needs\.relay-artifacts\.result == 'success'/,
  );
  assert.match(
    credentialJob,
    /Download relayed source-bound credential-island input[\s\S]*?needs\.artifact-transfer\.outputs\.mode == 's3-to-github-artifacts'/,
  );
  assert.match(
    credentialJob,
    /environment:\s*\n\s+name: \$\{\{ inputs\.credential-island-environment \}\}/,
  );
  assert.match(
    credentialJob,
    /uses: \.\/\.buildchain\/runtime\/actions\/macos-credential-island/,
  );
  assert.doesNotMatch(
    credentialJob,
    /actions\/checkout|pnpm|npm|yarn|consumer-script|install-command|build-command|verify-command/,
  );
  assert.match(
    workflow,
    /BUILDCHAIN_ADDITIONAL_PLATFORM_COUNT: \$\{\{ inputs\.credential-island-macos-app-path != '' && !inputs\.credential-island-caller-owned && '1' \|\| '0' \}\}/,
  );
  assert.doesNotMatch(implementation, /execSync|shell:\s*true/);
  assert.match(implementation, /schema:\s*EVIDENCE_CONTRACT/);
  assert.equal(
    EVIDENCE_CONTRACT,
    "buildchain.macos-credential-island-evidence/v1",
  );
});
