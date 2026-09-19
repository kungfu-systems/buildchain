import {
  PUBLICATION_BUILD_AGGREGATE,
  publicationArtifactProducer,
  verifyPublicationBuildAggregate,
} from "./build-segments.js";
import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import { createDomainPublicationQualificationReceipt } from "../publication-qualification.js";
import { verifyPipelinePublicationPlan } from "./plan.js";
import { inspectPipelineFileArtifact } from "./pack.js";
import { verifyPipelineProductFiles } from "./files.js";
import { publicationPath } from "./files.js";
import { assertPipelinePackagePolicy } from "./package-policy.js";
import { readNpmPackageJsonFromTarball } from "../../release/candidate/payloads.js";
import {
  qualifyNativeFinalizedBundle,
  verifyNativeFinalizationReadback,
} from "./native-qualification.js";

function productDescriptor(artifact) {
  const { file, size, digest, package: pkg, ...descriptor } = artifact;
  return descriptor;
}

export function inspectPipelinePublicationArtifacts(directory, manifest, plan) {
  verifyPipelineProductFiles(directory, manifest);
  for (const artifact of manifest.artifacts) {
    if (artifact.filename && path.basename(artifact.file) !== artifact.filename)
      throw new Error(
        "Independent qualification rejected the declared download filename",
      );
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

function verifyUnsignedProductReadback({ plan, source, bundles, build }) {
  if (build.schema === PUBLICATION_BUILD_AGGREGATE)
    verifyPublicationBuildAggregate(build, {
      plan,
      materialization: { source },
      runId: build.runId,
      runAttempt: build.runAttempt,
    });
  const { root: buildRoot, ...buildBody } = build;
  if (
    buildRoot !== recordDigest(buildBody) ||
    !Number.isSafeInteger(build.runId) ||
    build.runId < 1 ||
    ![
      "buildchain.pipeline-publication-build-readback/v1",
      PUBLICATION_BUILD_AGGREGATE,
    ].includes(build.schema) ||
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
}

export function qualifyPipelineProducts({
  plan,
  source,
  bundles,
  build,
  policyRoot,
  native,
  now = new Date(),
}) {
  verifyPipelinePublicationPlan(plan);
  if (plan.nativeSigning?.length && !native)
    throw new Error(
      "Native publication requires independently admitted signing and finalization evidence",
    );
  if (native) {
    if (!plan.nativeSigning?.length)
      throw new Error(
        "Unsigned publication cannot admit undeclared native signing",
      );
    verifyNativeFinalizationReadback(plan, source, native.finalized);
    const platforms = [
      ...new Set(plan.nativeSigning.map((rule) => rule.platform)),
    ].sort();
    if (
      recordDigest(native.signers.map((signer) => signer.platform).sort()) !==
      recordDigest(platforms)
    )
      throw new Error(
        "Native publication requires one independently observed signer per platform",
      );
  }
  verifyUnsignedProductReadback({ plan, source, bundles, build });
  const descriptors = [],
    artifacts = [],
    nativeProofs = [];
  for (const unsigned of bundles) {
    const { directory, manifest, providerArtifact } = unsigned;
    const producer = publicationArtifactProducer(build, providerArtifact.id);
    if (
      manifest.planRoot !== producer.build.planRoot ||
      recordDigest(manifest.source) !== recordDigest(source) ||
      !build.artifactIds.includes(providerArtifact.id) ||
      providerArtifact.expired ||
      providerArtifact.workflow_run?.id !== producer.build.runId
    )
      throw new Error(
        "Publication artifact is not bound to the exact admitted source run",
      );
    inspectPipelinePublicationArtifacts(directory, manifest, plan);
    let selected = unsigned;
    if (
      plan.nativeSigning?.some((rule) => rule.platform === manifest.platform)
    ) {
      const admitted = qualifyNativeFinalizedBundle({
        plan,
        source,
        unsigned,
        producerPlan: producer.plan || plan,
        finalized: native.finalized,
        signer: native.signers.find(
          (signer) => signer.platform === manifest.platform,
        ),
      });
      selected = admitted.bundle;
      nativeProofs.push(admitted.proof);
      inspectPipelinePublicationArtifacts(
        selected.directory,
        selected.manifest,
        plan,
      );
    }
    descriptors.push(...selected.manifest.artifacts.map(productDescriptor));
    artifacts.push(
      ...selected.manifest.artifacts.map((artifact) => ({
        ...artifact,
        manifestRoot: selected.manifest.root,
        providerArtifactId: selected.providerArtifact.id,
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
  const nativeBody = nativeProofs.length
    ? {
        schema: "buildchain.pipeline-native-qualification/v1",
        platforms: nativeProofs.sort((a, b) =>
          a.platform.localeCompare(b.platform),
        ),
      }
    : undefined;
  const nativeEvidence = nativeBody
    ? { ...nativeBody, root: recordDigest(nativeBody) }
    : undefined;
  const candidateRoot = recordDigest({
    planRoot: plan.root,
    source,
    artifacts,
    ...(nativeEvidence ? { nativeRoot: nativeEvidence.root } : {}),
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
    schema: `buildchain.pipeline-publication-qualification/v${nativeEvidence ? 2 : 1}`,
    planRoot: plan.root,
    source,
    build,
    artifacts,
    qualification,
    ...(nativeEvidence ? { native: nativeEvidence } : {}),
  };
  return { ...body, root: recordDigest(body) };
}
