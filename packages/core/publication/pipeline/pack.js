import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { packNpmArtifact, sealedPackResult } from "../npm/package.js";
import { readNpmPackageJsonFromTarball } from "../../release/candidate/payloads.js";
import { createNativeChildEnvironment } from "../../dev-delivery/native/execution.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { verifyPipelinePublicationPlan } from "./plan.js";
import { assertPipelinePackagePolicy } from "./package-policy.js";
import {
  publicationPath,
  publicationFile,
  writeImmutablePublicationFile,
} from "./files.js";

function packageArtifact(directory, output, expected, version, environment) {
  const product = publicationPath(directory, expected.path, "directory");
  const pack = packNpmArtifact({
    cwd: product,
    env: createNativeChildEnvironment(environment),
    outputDirectory: output,
    ignoreScripts: true,
    registry: "https://registry.npmjs.org/",
  });
  const sealed = sealedPackResult({
    tarballPath: pack.tarballPath,
    integrity: pack.integrity,
  });
  const pkg = readNpmPackageJsonFromTarball(pack.tarballPath);
  assertPipelinePackagePolicy(pkg);
  if (
    pkg.name !== pack.name ||
    pkg.version !== version ||
    pack.version !== version ||
    pkg.private === true
  )
    throw new Error(
      "Sealed npm package does not match the planned public package version",
    );
  return {
    file: pack.tarballPath,
    suffix: ".tgz",
    package: { name: pkg.name, version, integrity: sealed.integrity },
  };
}

export function inspectPipelineFileArtifact(directory, expected) {
  const file = publicationPath(directory, expected.path);
  if (expected.kind === "pdf") {
    const bytes = fs.readFileSync(file);
    if (
      !bytes.subarray(0, 8).toString().startsWith("%PDF-") ||
      !bytes.subarray(-1024).toString().includes("%%EOF")
    )
      throw new Error("Declared Paper output is not a complete PDF document");
    return { file, suffix: ".pdf" };
  }
  const suffix = [".tar.gz", ".tar.xz", ".tgz", ".zip", ".tar"].find((value) =>
    file.endsWith(value),
  );
  if (!suffix)
    throw new Error("Declared binary output must be a standard archive");
  const names = execFileSync("tar", ["-tf", path.basename(file)], {
    cwd: path.dirname(file),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split(/\r?\n/u);
  if (
    !names[0] ||
    names.some(
      (name) =>
        name.startsWith("/") ||
        /^[A-Za-z]:/u.test(name) ||
        name.replaceAll("\\", "/").split("/").includes(".."),
    )
  )
    throw new Error("Binary archive contains unsafe or empty paths");
  return { file, suffix };
}

export function packPipelineProducts({
  cwd,
  output,
  plan,
  platform,
  source,
  environment = process.env,
}) {
  verifyPipelinePublicationPlan(plan);
  const expected = plan.outputs.filter((item) => item.platform === platform);
  if (!expected.length)
    throw new Error("Publication platform was not declared");
  fs.mkdirSync(output, { recursive: true });
  const artifacts = expected.map((item) => {
    const directory = publicationPath(cwd, item.directory, "directory");
    const staging = path.join(output, "npm-pack", item.product, item.artifact);
    const packed =
      item.kind === "npm-package"
        ? packageArtifact(directory, staging, item, plan.version, environment)
        : inspectPipelineFileArtifact(directory, item);
    const observed = publicationFile(packed.file);
    const name = `${item.product}-${platform}-${item.artifact}${packed.suffix}`;
    writeImmutablePublicationFile(
      path.join(output, "payloads", name),
      observed.bytes,
    );
    return {
      ...item,
      file: `payloads/${name}`,
      size: observed.size,
      digest: observed.digest,
      ...(packed.package ? { package: packed.package } : {}),
    };
  });
  const body = {
    schema: "buildchain.pipeline-publication-products/v1",
    planRoot: plan.root,
    source,
    platform,
    artifacts,
  };
  const manifest = { ...body, root: recordDigest(body) };
  writeImmutablePublicationFile(
    path.join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export function verifyPipelineProductFiles(directory, manifest) {
  const { root, ...body } = manifest;
  if (
    body.schema !== "buildchain.pipeline-publication-products/v1" ||
    root !== recordDigest(body)
  )
    throw new Error("Publication manifest root does not match retained bytes");
  for (const artifact of manifest.artifacts) {
    const observed = publicationFile(publicationPath(directory, artifact.file));
    if (
      observed.size !== artifact.size ||
      observed.digest !== artifact.digest ||
      (artifact.package && observed.integrity !== artifact.package.integrity)
    )
      throw new Error(
        "Publication artifact changed after its manifest was sealed",
      );
  }
  return manifest;
}
