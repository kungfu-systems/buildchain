import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export async function bindQualifiedPackage(env, execute = spawnSync) {
  fs.mkdirSync(".buildchain/paper-release", { recursive: true });

  const receipt = JSON.parse(
    fs.readFileSync(
      ".buildchain/publication/reproducibility-receipt.json",
      "utf8",
    ),
  );
  if (receipt.status !== "passed" || receipt.qualifying !== true) {
    throw new Error(
      `publication reproducibility receipt is not qualifying: ${receipt.status}`,
    );
  }
  const qualified = receipt.builds?.[0];
  const packageDir = path.resolve(".buildchain/publication/npm-package");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  );
  if (env.INPUT_PACKAGE_NAME && env.INPUT_PACKAGE_NAME !== packageJson.name) {
    throw new Error(
      `qualified package name mismatch: expected ${env.INPUT_PACKAGE_NAME}, got ${packageJson.name}`,
    );
  }
  const pack = execute(
    "npm",
    ["pack", "--dry-run", "--json", "--registry=https://registry.npmjs.org/"],
    {
      cwd: packageDir,
      encoding: "utf8",
    },
  );
  if (pack.error || pack.status !== 0) {
    const error = new Error("npm pack --dry-run failed");
    error.status = pack.status || 1;
    throw error;
  }
  const packResult = JSON.parse(pack.stdout);
  if (!Array.isArray(packResult) || packResult.length !== 1)
    throw new Error("npm pack must report exactly one qualified package");
  const first = packResult[0];
  if (!first?.integrity)
    throw new Error("npm pack --dry-run did not report sha512 integrity");
  if (first.integrity !== qualified?.npmPackage?.integrity) {
    throw new Error(
      `qualified npm integrity changed: ${qualified?.npmPackage?.integrity || "(missing)"} != ${first.integrity}`,
    );
  }
  const targetRef = env.INPUT_TARGET_REF || "";
  const channel = targetRef.startsWith("release/") ? "release" : "alpha";
  const distTag =
    env.INPUT_PUBLISH_DIST_TAG || (channel === "release" ? "latest" : "alpha");
  const requiredArtifacts = [
    {
      group: "node",
      kind: "npm",
      name: packageJson.name,
      ref: packageJson.version,
      digest: first.integrity,
      integrity: first.integrity,
      role: "main",
    },
  ];
  fs.writeFileSync(
    ".buildchain/paper-release/publish-required-artifacts.json",
    `${JSON.stringify(requiredArtifacts, null, 2)}\n`,
  );
  fs.writeFileSync(
    ".buildchain/paper-release/build-summary.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        contract: "kungfu-buildchain-paper-release-build-summary",
        repository: env.GITHUB_REPOSITORY || "",
        sourceSha: env.GITHUB_SHA || "",
        package: { name: packageJson.name, version: packageJson.version },
        reproducibility: {
          receiptPath: ".buildchain/publication/reproducibility-receipt.json",
          receiptDigest: receipt.receiptDigest,
          npmIntegrity: qualified.npmPackage.integrity,
          npmSha256: qualified.npmPackage.sha256,
        },
        publication: {
          manifestPath: qualified.publication.manifestPath,
          passportPath: qualified.publication.passportPath,
          registryPath: qualified.publication.registryPath || "",
          primaryArtifact: qualified.artifacts?.[0]?.path || "",
        },
        platforms: [
          { id: "paper", manifestPath: qualified.publication.manifestPath },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const output = env.GITHUB_OUTPUT;
  fs.appendFileSync(output, `package-name=${packageJson.name}\n`);
  fs.appendFileSync(output, `package-version=${packageJson.version}\n`);
  fs.appendFileSync(output, `dist-tag=${distTag}\n`);
}
