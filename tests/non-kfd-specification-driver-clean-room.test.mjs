import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(
  repositoryRoot,
  "fixtures/ledger-specification-driver",
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.error || ""}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function pack(cwd, destination, environment) {
  const output = run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    { cwd, env: environment, shell: process.platform === "win32" },
  );
  const [{ filename }] = JSON.parse(output);
  return path.join(destination, filename);
}

function extractPackage(tarball, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const archive = path.relative(destination, tarball).split(path.sep).join("/");
  run(
    "tar",
    ["-xzf", archive, "--strip-components=1"],
    { cwd: destination },
  );
}

function replacePointer(target, pointer, value) {
  const parts = pointer.split("/").slice(1);
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  cursor[parts.at(-1)] = value;
}

test("an independent non-KFD specification package replays through the common gate", async () => {
  const cleanRoom = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-ledger-clean-room-"),
  );
  try {
    const tarballs = path.join(cleanRoom, "tarballs");
    fs.mkdirSync(tarballs);
    const emptyHome = path.join(cleanRoom, "empty-home");
    const npmCache = path.join(cleanRoom, "npm-cache");
    fs.mkdirSync(emptyHome);
    const packageOnlyEnvironment = {
      PATH: process.env.PATH,
      HOME: emptyHome,
      ...(process.platform === "win32"
        ? {
            ComSpec: process.env.ComSpec,
            PATHEXT: process.env.PATHEXT,
            SystemRoot: process.env.SystemRoot,
          }
        : {}),
      npm_config_audit: "false",
      npm_config_cache: npmCache,
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_userconfig: path.join(cleanRoom, "absent-npmrc"),
    };
    const buildchainTarball = pack(
      repositoryRoot,
      tarballs,
      packageOnlyEnvironment,
    );
    const fixtureTarball = pack(fixtureRoot, tarballs, packageOnlyEnvironment);

    const modules = path.join(cleanRoom, "node_modules");
    const buildchainPackage = path.join(modules, "@kungfu-tech", "buildchain");
    const fixturePackage = path.join(
      modules,
      "@buildchain-fixtures",
      "ledger-specification-driver",
    );
    extractPackage(buildchainTarball, buildchainPackage);
    extractPackage(fixtureTarball, fixturePackage);

    assert.equal(
      fs.existsSync(path.join(modules, "@kungfu-tech", "kfd")),
      false,
    );
    const packageEntries = fs.readdirSync(path.join(modules, "@kungfu-tech"));
    assert.deepEqual(packageEntries, ["buildchain"]);
    const fixtureManifest = JSON.parse(
      fs.readFileSync(path.join(fixturePackage, "package.json"), "utf8"),
    );
    assert.equal(fixtureManifest.dependencies, undefined);
    assert.deepEqual(Object.keys(fixtureManifest.peerDependencies), [
      "@kungfu-tech/buildchain",
    ]);
    for (const relativePath of [
      "authority.json",
      "driver.js",
      "vectors.json",
      "verifier.js",
    ]) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(fixturePackage, relativePath), "utf8"),
        /@kungfu-tech\/kfd/u,
      );
    }

    const gateModule = await import(
      pathToFileURL(
        path.join(buildchainPackage, "packages/core/adopter-delivery-gate.js"),
      )
    );
    const passportModule = await import(
      pathToFileURL(
        path.join(
          buildchainPackage,
          "packages/core/adopter-delivery-passport.js",
        ),
      )
    );
    const { default: ledgerDriver } = await import(
      pathToFileURL(path.join(fixturePackage, "driver.js"))
    );
    const { ledgerEvidenceRoot, ledgerSemanticRoot } = await import(
      pathToFileURL(path.join(fixturePackage, "verifier.js"))
    );
    const vectors = JSON.parse(
      fs.readFileSync(path.join(fixturePackage, "vectors.json"), "utf8"),
    );

    const suitePreimage = structuredClone(vectors);
    delete suitePreimage.suiteRoot;
    assert.equal(ledgerSemanticRoot(suitePreimage), vectors.suiteRoot);

    const request = structuredClone(vectors.request);
    assert.deepEqual(
      request.declaration.specification.evidence,
      request.declaration.specification.claims.map((claim) => ({
        claim,
        root: ledgerEvidenceRoot({
          claim,
          project: request.declaration.specification.project,
          artifactRoot: request.declaration.specification.artifactRoot,
        }),
      })),
    );
    const unrelatedDriver = gateModule.defineAdopterProtocolDriver({
      interface: gateModule.ADOPTER_PROTOCOL_DRIVER_INTERFACE,
      id: "example.specification/unrelated",
      version: "1.0.0",
      verify() {
        throw new Error(
          "The selected ledger request must not invoke this driver.",
        );
      },
    });
    const isolatedGate = gateModule.createAdopterDeliveryGate({
      drivers: [ledgerDriver],
      artifactProfiles: [gateModule.createPackageArtifactProfile()],
    });
    const combinedGate = gateModule.createAdopterDeliveryGate({
      drivers: [unrelatedDriver, ledgerDriver],
      artifactProfiles: [gateModule.createPackageArtifactProfile()],
    });

    const isolated = isolatedGate.evaluate(request);
    const replay = isolatedGate.evaluate(request);
    const combined = combinedGate.evaluate(request);
    assert.equal(isolated.status, "passed");
    assert.equal(isolated.qualifying, false);
    assert.equal(isolated.selfCertified, false);
    assert.equal(replay.gateRoot, isolated.gateRoot);
    assert.equal(combined.gateRoot, isolated.gateRoot);

    for (const vector of vectors.negativeSubstitutions) {
      const substituted = structuredClone(request);
      replacePointer(substituted, vector.path, vector.value);
      const result = isolatedGate.evaluate(substituted);
      assert.equal(result.status, "failed", vector.id);
      assert.equal(
        result.issues.some(({ code }) => code === vector.issueCode),
        true,
        vector.id,
      );
    }

    const passport =
      passportModule.createAdopterDeliveryPassportBinding(isolated);
    assert.equal(passport.valid, true);
    assert.equal(passport.qualifying, false);
    assert.equal(passport.selfCertified, false);
    assert.equal(passport.gateResult.gateRoot, isolated.gateRoot);
  } finally {
    fs.rmSync(cleanRoom, { recursive: true, force: true });
  }
});
