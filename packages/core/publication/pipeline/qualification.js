import { recordDigest } from "../../release/discussion/envelope.js";
import { createDomainPublicationQualificationReceipt } from "../publication-qualification.js";
import { verifyPipelinePublicationPlan } from "./plan.js";
import {
  inspectPipelineFileArtifact,
  verifyPipelineProductFiles,
} from "./pack.js";
import { publicationPath } from "./files.js";
import { assertPipelinePackagePolicy } from "./package-policy.js";
import { readNpmPackageJsonFromTarball } from "../../release/candidate/payloads.js";

function productDescriptor(artifact) {
  const { file, size, digest, package: pkg, ...descriptor } = artifact;
  return descriptor;
}

function inspectArtifacts(directory, manifest, plan) {
  verifyPipelineProductFiles(directory, manifest);
  for (const artifact of manifest.artifacts) {
    if (artifact.kind === "npm-package") {
      const pkg = readNpmPackageJsonFromTarball(
        publicationPath(directory, artifact.file),
      );
      assertPipelinePackagePolicy(pkg);
      if (
        !artifact.package ||
        pkg.name !== artifact.package.name ||
        pkg.version !== plan.version ||
        pkg.version !== artifact.package.version ||
        pkg.private === true
      )
        throw new Error(
          "Independent npm qualification rejected package identity or version",
        );
    } else
      inspectPipelineFileArtifact(directory, {
        path: artifact.file,
        kind: artifact.kind,
      });
  }
}

export function qualifyPipelineProducts({
  plan,
  source,
  bundles,
  build,
  policyRoot,
  now = new Date(),
}) {
  verifyPipelinePublicationPlan(plan);
  const { root: buildRoot, ...buildBody } = build;
  if (
    buildRoot !== recordDigest(buildBody) ||
    !Number.isSafeInteger(build.runId) ||
    build.runId < 1 ||
    build.schema !== "buildchain.pipeline-publication-build-readback/v1" ||
    build.outcome !== "success" ||
    build.planRoot !== plan.root ||
    recordDigest(build.source) !== recordDigest(source)
  )
    throw new Error(
      "Publication requires exact independent completed build readback",
    );
  const platforms = [
    ...new Set(plan.outputs.map(({ platform }) => platform)),
  ].sort();
  const observed = bundles.map(({ manifest }) => manifest.platform).sort();
  if (
    recordDigest(platforms) !== recordDigest(observed) ||
    recordDigest(platforms) !== recordDigest(build.platforms)
  )
    throw new Error(
      "Publication build must cover exactly every declared platform",
    );
  const artifactIds = bundles
    .map(({ providerArtifact }) => providerArtifact.id)
    .sort((left, right) => left - right);
  if (
    new Set(artifactIds).size !== platforms.length ||
    recordDigest(artifactIds) !== recordDigest(build.artifactIds)
  )
    throw new Error(
      "Publication readback must cover exactly the retained provider artifacts",
    );
  const descriptors = [],
    artifacts = [];
  for (const { directory, manifest, providerArtifact } of bundles) {
    if (
      manifest.planRoot !== plan.root ||
      recordDigest(manifest.source) !== recordDigest(source) ||
      !build.artifactIds.includes(providerArtifact.id) ||
      providerArtifact.expired ||
      providerArtifact.workflow_run?.id !== build.runId
    )
      throw new Error(
        "Publication artifact is not bound to the exact admitted source run",
      );
    inspectArtifacts(directory, manifest, plan);
    descriptors.push(...manifest.artifacts.map(productDescriptor));
    artifacts.push(
      ...manifest.artifacts.map((artifact) => ({
        ...artifact,
        manifestRoot: manifest.root,
        providerArtifactId: providerArtifact.id,
      })),
    );
  }
  descriptors.sort((left, right) => left.id.localeCompare(right.id));
  artifacts.sort((left, right) => left.id.localeCompare(right.id));
  if (recordDigest(descriptors) !== recordDigest(plan.outputs))
    throw new Error(
      "Publication artifacts do not exactly match declared outputs and targets",
    );
  if (new Set(artifacts.map(({ file }) => file)).size !== artifacts.length)
    throw new Error("Publication asset filenames must be unique");
  const packages = artifacts.filter((artifact) => artifact.package);
  if (
    new Set(packages.map(({ package: pkg }) => pkg.name)).size !==
    packages.length
  )
    throw new Error(
      "Multi-platform npm publication requires distinct declared package names",
    );
  const candidateRoot = recordDigest({
    planRoot: plan.root,
    source,
    artifacts,
  });
  const qualification = createDomainPublicationQualificationReceipt({
    repository: source.repository,
    candidateRoot,
    sourceSha: source.commit,
    sourceRoot: recordDigest(source),
    policyDigest: policyRoot,
    artifacts: artifacts.map((artifact) => ({
      role: `${artifact.product}/${artifact.artifact}`,
      platform: artifact.platform,
      artifactRoot: artifact.digest,
      manifestRoot: artifact.manifestRoot,
    })),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
  });
  const body = {
    schema: "buildchain.pipeline-publication-qualification/v1",
    planRoot: plan.root,
    source,
    build,
    artifacts,
    qualification,
  };
  return { ...body, root: recordDigest(body) };
}
