import fs from "node:fs";
import path from "node:path";
import { runNpm } from "../npm/registry.js";

export async function bindQualifiedPackage(
  {
    cwd,
    packageName = "",
    targetRef = "",
    publishDistTag = "",
    repository,
    sourceSha,
    env,
  },
  execute = runNpm,
) {
  fs.mkdirSync(path.join(cwd, ".buildchain/paper-release"), {
    recursive: true,
  });

  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(cwd, ".buildchain/publication/reproducibility-receipt.json"),
      "utf8",
    ),
  );
  if (receipt.status !== "passed" || receipt.qualifying !== true) {
    throw new Error(
      `publication reproducibility receipt is not qualifying: ${receipt.status}`,
    );
  }
  const qualified = receipt.builds?.[0];
  const packageDir = path.resolve(cwd, ".buildchain/publication/npm-package");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  );
  if (packageName && packageName !== packageJson.name) {
    throw new Error(
      `qualified package name mismatch: expected ${packageName}, got ${packageJson.name}`,
    );
  }
  const pack = execute({
    cwd: packageDir,
    env,
    args: [
      "pack",
      "--dry-run",
      "--json",
      "--registry=https://registry.npmjs.org/",
    ],
  });
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
  const channel = targetRef.startsWith("release/") ? "release" : "alpha";
  const distTag =
    publishDistTag || (channel === "release" ? "latest" : "alpha");
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
    path.join(cwd, ".buildchain/paper-release/publish-required-artifacts.json"),
    `${JSON.stringify(requiredArtifacts, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, ".buildchain/paper-release/build-summary.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        contract: "kungfu-buildchain-paper-release-build-summary",
        repository: repository,
        sourceSha: sourceSha,
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
  return {
    "package-name": packageJson.name,
    "package-version": packageJson.version,
    "dist-tag": distTag,
  };
}
