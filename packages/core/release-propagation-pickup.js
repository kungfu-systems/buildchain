import {
  assertExactFields,
  assertPlainObject,
  assertString,
  normalizeChannel,
  optionalString,
} from "./release-propagation-common.js";
import { normalizeExecutionProfile } from "./release-propagation-execution-profile.js";
import { assertCommitSha } from "./release-propagation-work-control.js";
import {
  createReleasePropagationWork,
  planReleasePropagation,
} from "./release-propagation.js";
import { normalizeUpstreamRelease } from "./release-propagation-release.js";

export const MANUAL_UPSTREAM_PICKUP_CONFIG_CONTRACT =
  "kungfu-buildchain-manual-upstream-pickup";
export const MANUAL_UPSTREAM_PICKUP_PLAN_CONTRACT =
  "kungfu-buildchain-manual-upstream-pickup-plan";

function assertRepository(value, label) {
  const repository = assertString(value, label);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`${label} must be owner/repo`);
  }
  return repository;
}

function normalizeStringList(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const normalized = values.map((value, index) =>
    assertString(value, `${label}[${index}]`),
  );
  const canonical = [...new Set(normalized)].sort();
  if (JSON.stringify(normalized) !== JSON.stringify(canonical)) {
    throw new Error(`${label} must be sorted and unique`);
  }
  return canonical;
}

function normalizeRuntime(value) {
  const runtime = assertExactFields(
    value,
    ["package", "version"],
    "manual pickup runtime",
  );
  return {
    package: assertString(runtime.package, "manual pickup runtime.package"),
    version: assertString(runtime.version, "manual pickup runtime.version"),
  };
}

function normalizeDownstream(value) {
  const downstream = assertExactFields(
    value,
    ["id", "repository", "baseRef", "executionProfile"],
    "manual pickup downstream",
  );
  return {
    id: assertString(downstream.id, "manual pickup downstream.id"),
    repository: assertRepository(
      downstream.repository,
      "manual pickup downstream.repository",
    ),
    baseRef: assertString(
      downstream.baseRef,
      "manual pickup downstream.baseRef",
    ),
    executionProfile: normalizeExecutionProfile(
      downstream.executionProfile,
      "manual pickup downstream.executionProfile",
    ),
  };
}

function normalizeSource(value, index) {
  const label = `manual pickup sources[${index}]`;
  const source = assertExactFields(
    value,
    [
      "id",
      "repository",
      "package",
      "lockPath",
      "distTags",
      "workflowPaths",
      "workflowRefs",
    ],
    label,
  );
  const distTags = assertExactFields(
    source.distTags,
    ["alpha", "release"],
    `${label}.distTags`,
  );
  return {
    id: assertString(source.id, `${label}.id`),
    repository: assertRepository(source.repository, `${label}.repository`),
    package: assertString(source.package, `${label}.package`),
    lockPath: assertString(source.lockPath, `${label}.lockPath`),
    distTags: {
      alpha: assertString(distTags.alpha, `${label}.distTags.alpha`),
      release: assertString(distTags.release, `${label}.distTags.release`),
    },
    workflowPaths: normalizeStringList(
      source.workflowPaths,
      `${label}.workflowPaths`,
    ),
    workflowRefs: normalizeStringList(
      source.workflowRefs,
      `${label}.workflowRefs`,
    ),
  };
}

export function normalizeManualUpstreamPickupConfig(input) {
  const config = assertExactFields(
    input,
    ["schemaVersion", "contract", "runtime", "downstream", "sources"],
    "manual upstream pickup config",
  );
  if (
    config.schemaVersion !== 1 ||
    config.contract !== MANUAL_UPSTREAM_PICKUP_CONFIG_CONTRACT
  ) {
    throw new Error(
      `manual upstream pickup config must use ${MANUAL_UPSTREAM_PICKUP_CONFIG_CONTRACT} v1`,
    );
  }
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new Error(
      "manual upstream pickup config sources must be a non-empty array",
    );
  }
  const sources = config.sources.map(normalizeSource);
  const ids = sources.map((source) => source.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("manual pickup source ids must be unique");
  return {
    schemaVersion: 1,
    contract: MANUAL_UPSTREAM_PICKUP_CONFIG_CONTRACT,
    runtime: normalizeRuntime(config.runtime),
    downstream: normalizeDownstream(config.downstream),
    sources,
  };
}

function decodePayload(attestation, label) {
  const encoded = attestation?.bundle?.dsseEnvelope?.payload;
  if (!encoded) throw new Error(`${label} is missing a DSSE payload`);
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error(`${label} DSSE payload is not valid JSON`);
  }
}

function repositoryFromUrl(value) {
  return String(value || "")
    .replace(/^git\+/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
}

export function resolveNpmRegistryRelease({
  source: sourceInput,
  channel,
  packageMetadata,
  attestations,
}) {
  const source = normalizeSource(sourceInput, 0);
  const normalizedChannel = normalizeChannel(channel, "manual pickup channel");
  const metadata = assertPlainObject(packageMetadata, "npm package metadata");
  if (metadata.name !== source.package)
    throw new Error("npm package name disagrees with manual pickup source");
  if (
    repositoryFromUrl(metadata.repository?.url || metadata.repository) !==
    source.repository
  ) {
    throw new Error(
      "npm package repository disagrees with manual pickup source",
    );
  }
  const version = assertString(
    metadata.version,
    "npm package metadata.version",
  );
  const integrity = assertString(
    metadata.dist?.integrity,
    "npm package metadata.dist.integrity",
  );
  const attestationUrl = assertString(
    metadata.dist?.attestations?.url,
    "npm package metadata.dist.attestations.url",
  );
  const response = assertPlainObject(attestations, "npm attestations response");
  const slsa = (response.attestations || []).find(
    (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
  );
  if (!slsa) throw new Error("npm package does not expose SLSA provenance v1");
  const statement = decodePayload(slsa, "npm SLSA provenance");
  if (statement.predicateType !== "https://slsa.dev/provenance/v1") {
    throw new Error(
      "npm SLSA statement predicate type disagrees with its envelope",
    );
  }
  const expectedSubject = `pkg:npm/${encodeURIComponent(source.package)}@${version}`;
  const subject = (statement.subject || []).find(
    (entry) => entry.name === expectedSubject,
  );
  if (!subject?.digest?.sha512)
    throw new Error("npm SLSA provenance is missing the exact package subject");
  const workflow =
    statement.predicate?.buildDefinition?.externalParameters?.workflow || {};
  const workflowRepository = repositoryFromUrl(workflow.repository);
  if (workflowRepository !== source.repository) {
    throw new Error(
      "npm SLSA workflow repository disagrees with manual pickup source",
    );
  }
  if (!source.workflowPaths.includes(workflow.path)) {
    throw new Error(
      "npm SLSA workflow path is not admitted by the manual pickup source",
    );
  }
  if (!source.workflowRefs.includes(workflow.ref)) {
    throw new Error(
      "npm SLSA workflow ref is not admitted by the manual pickup source",
    );
  }
  const dependency = (
    statement.predicate?.buildDefinition?.resolvedDependencies || []
  ).find(
    (entry) =>
      repositoryFromUrl(String(entry.uri || "").split("@")[0]) ===
      source.repository,
  );
  const sourceSha = assertCommitSha(
    dependency?.digest?.gitCommit,
    "npm SLSA source commit",
  );
  const runUrl = assertString(
    statement.predicate?.runDetails?.metadata?.invocationId,
    "npm SLSA invocation URL",
  );
  return normalizeUpstreamRelease({
    repository: source.repository,
    channel: normalizedChannel,
    tag: "",
    tagTargetSha: "",
    sourceSha,
    package: {
      name: source.package,
      version,
      integrity,
      gitHead: optionalString(metadata.gitHead),
    },
    registryProvenance: {
      registry: "https://registry.npmjs.org",
      attestationUrl,
      predicateType: slsa.predicateType,
      subjectSha512: subject.digest.sha512,
      repository: source.repository,
      sourceSha,
      workflowPath: workflow.path,
      workflowRef: workflow.ref,
      runUrl,
    },
  });
}

function pickupGraph(config, source) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-propagation-graph",
    nodes: [
      { id: source.id, repository: source.repository, package: source.package },
      {
        id: config.downstream.id,
        repository: config.downstream.repository,
        baseRef: config.downstream.baseRef,
        lockPath: source.lockPath,
        executionProfile: config.downstream.executionProfile,
      },
    ],
    edges: [
      {
        id: `${source.id}-manual-pickup`,
        from: source.id,
        to: config.downstream.id,
        channels: ["alpha", "release"],
        channelPolicy: "preserve",
        lockPath: source.lockPath,
        prBaseRef: config.downstream.baseRef,
      },
    ],
  };
}

export function createManualUpstreamPickupPlan({
  config: configInput,
  sourceId,
  channel,
  currentVersion,
  upstreamRelease,
}) {
  const config = normalizeManualUpstreamPickupConfig(configInput);
  const source = config.sources.find((entry) => entry.id === sourceId);
  if (!source)
    throw new Error(`manual pickup source is not configured: ${sourceId}`);
  const release = normalizeUpstreamRelease(upstreamRelease);
  const normalizedChannel = normalizeChannel(channel, "manual pickup channel");
  if (
    release.repository !== source.repository ||
    release.package?.name !== source.package
  ) {
    throw new Error("manual pickup release disagrees with the selected source");
  }
  if (release.channel !== normalizedChannel)
    throw new Error("manual pickup release channel disagrees with the request");
  const installedVersion = assertString(
    currentVersion,
    "manual pickup currentVersion",
  );
  const status =
    installedVersion === release.package.version
      ? "current"
      : "update-available";
  const propagationPlan =
    status === "current"
      ? null
      : planReleasePropagation({
          graph: pickupGraph(config, source),
          upstreamRelease: release,
          sourceNode: source.id,
        });
  return {
    schemaVersion: 1,
    contract: MANUAL_UPSTREAM_PICKUP_PLAN_CONTRACT,
    invocation: "downstream-manual",
    automaticTrigger: false,
    runtime: config.runtime,
    source: {
      id: source.id,
      repository: source.repository,
      package: source.package,
      channel: normalizedChannel,
      distTag: source.distTags[normalizedChannel],
    },
    currentVersion: installedVersion,
    resolvedVersion: release.package.version,
    status,
    upstreamRelease: release,
    propagationPlan,
  };
}

export function createManualUpstreamPickupCapture({
  plan,
  expectedDownstreamBaseSha,
}) {
  const pickup = assertPlainObject(plan, "manual pickup plan");
  if (
    pickup.contract !== MANUAL_UPSTREAM_PICKUP_PLAN_CONTRACT ||
    pickup.schemaVersion !== 1
  ) {
    throw new Error("manual pickup plan must use the v1 contract");
  }
  if (pickup.status === "current") {
    return { plan: pickup, work: null, nextAction: "none" };
  }
  if (pickup.status !== "update-available" || !pickup.propagationPlan) {
    throw new Error("manual pickup plan has an invalid status");
  }
  const expectedBaseSha = assertCommitSha(
    expectedDownstreamBaseSha,
    "expectedDownstreamBaseSha",
  );
  const work = createReleasePropagationWork({
    plan: pickup.propagationPlan,
    expectedDownstreamBaseSha: expectedBaseSha,
  });
  return { plan: pickup, work, nextAction: "claim" };
}
