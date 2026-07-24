import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_PROPAGATION_GRAPH_CONTRACT = "kungfu-buildchain-release-propagation-graph";
export const RELEASE_PROPAGATION_PLAN_CONTRACT = "kungfu-buildchain-release-propagation-plan";
export const RELEASE_PROPAGATION_LOCK_CONTRACT = "kungfu-buildchain-release-propagation-lock";

const SUPPORTED_CHANNELS = new Set(["alpha", "release"]);
const SUPPORTED_CHANNEL_POLICIES = new Set(["preserve", "explicit"]);

function stableJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeChannel(value, label) {
  const channel = assertString(value, label);
  if (!SUPPORTED_CHANNELS.has(channel)) {
    throw new Error(`${label} must be alpha or release`);
  }
  return channel;
}

function normalizeChannelMap(edge, label) {
  const policy = edge.channelPolicy || "preserve";
  if (!SUPPORTED_CHANNEL_POLICIES.has(policy)) {
    throw new Error(`${label}.channelPolicy must be preserve or explicit`);
  }
  const map = {
    alpha: "alpha",
    release: "release",
    ...(edge.channelMap || {}),
  };
  if (policy === "explicit" && !edge.channelMap) {
    throw new Error(`${label}.channelMap is required when channelPolicy is explicit`);
  }
  for (const channel of Object.keys(map)) {
    normalizeChannel(channel, `${label}.channelMap key`);
    normalizeChannel(map[channel], `${label}.channelMap.${channel}`);
  }
  return { policy, map };
}

function normalizeNode(node, index) {
  assertPlainObject(node, `nodes[${index}]`);
  const normalized = {
    id: assertString(node.id, `nodes[${index}].id`),
    repository: assertString(node.repository, `nodes[${index}].repository`),
    package: optionalString(node.package),
    lockPath: optionalString(node.lockPath || node.lock_path),
    baseRef: optionalString(node.baseRef || node.base_ref),
    workflow: optionalString(node.workflow),
  };
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized.repository)) {
    throw new Error(`nodes[${index}].repository must be owner/repo`);
  }
  return normalized;
}

function normalizeEdge(edge, index) {
  assertPlainObject(edge, `edges[${index}]`);
  const channel = normalizeChannelMap({
    channelPolicy: edge.channelPolicy || edge.channel_policy,
    channelMap: edge.channelMap || edge.channel_map,
  }, `edges[${index}]`);
  const channels = edge.channels === undefined
    ? ["alpha", "release"]
    : edge.channels.map((entry, channelIndex) => normalizeChannel(entry, `edges[${index}].channels[${channelIndex}]`));
  return {
    id: optionalString(edge.id) || `edge-${index + 1}`,
    from: assertString(edge.from, `edges[${index}].from`),
    to: assertString(edge.to, `edges[${index}].to`),
    channels,
    channelPolicy: channel.policy,
    channelMap: channel.map,
    lockPath: optionalString(edge.lockPath || edge.lock_path),
    prBaseRef: optionalString(edge.prBaseRef || edge.pr_base_ref),
  };
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} contains duplicate value: ${value}`);
    }
    seen.add(value);
  }
}

function assertAcyclic(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge.to);
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = stack.slice(start).concat(id).join(" -> ");
      throw new Error(`release propagation graph contains a cycle: ${cycle}`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const next of outgoing.get(id) || []) {
      visit(next);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of nodes) {
    visit(node.id);
  }
}

export function normalizeReleasePropagationGraph(input) {
  const graph = assertPlainObject(input, "release propagation graph");
  const nodes = (graph.nodes || []).map(normalizeNode);
  const edges = (graph.edges || []).map(normalizeEdge);
  if (nodes.length === 0) {
    throw new Error("release propagation graph requires nodes[]");
  }
  assertUnique(nodes.map((node) => node.id), "nodes.id");
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`edge ${edge.id} references unknown from node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`edge ${edge.id} references unknown to node: ${edge.to}`);
    }
  }
  assertAcyclic(nodes, edges);
  return {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_GRAPH_CONTRACT,
    channelPolicy: graph.channelPolicy || graph.channel_policy || "preserve",
    nodes,
    edges,
  };
}

export function resolvePropagationChannel(edge, upstreamChannel) {
  const channel = normalizeChannel(upstreamChannel, "upstreamRelease.channel");
  if (!edge.channels.includes(channel)) {
    return "";
  }
  const downstreamChannel = edge.channelMap[channel] || "";
  return downstreamChannel ? normalizeChannel(downstreamChannel, `edge ${edge.id} downstream channel`) : "";
}

function normalizeReleasePassport(passport = {}) {
  if (!passport || typeof passport !== "object" || Array.isArray(passport)) {
    throw new Error("upstreamRelease.releasePassport must be an object");
  }
  return {
    url: assertString(passport.url, "upstreamRelease.releasePassport.url"),
    sha256: assertString(passport.sha256 || passport.digest, "upstreamRelease.releasePassport.sha256"),
  };
}

function normalizePackageFact(pkg = {}) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new Error("upstreamRelease.package must be an object");
  }
  return {
    name: assertString(pkg.name, "upstreamRelease.package.name"),
    version: assertString(pkg.version, "upstreamRelease.package.version"),
    integrity: assertString(pkg.integrity, "upstreamRelease.package.integrity"),
  };
}

function normalizeDigestUrlFact(value = {}, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return {
    url: assertString(value.url, `${label}.url`),
    sha256: assertString(value.sha256 || value.digest, `${label}.sha256`),
  };
}

function normalizeOptionalPathDigestUrlFact(value = undefined, label) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = normalizeDigestUrlFact(value, label);
  return {
    path: optionalString(value.path),
    bytes: value.bytes === undefined ? undefined : Number(value.bytes),
    ...normalized,
  };
}

function normalizePublicationArtifactFact(value = undefined) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const artifact = assertPlainObject(value, "upstreamRelease.publicationArtifact");
  return {
    id: optionalString(artifact.id),
    kind: optionalString(artifact.kind),
    version: assertString(artifact.version, "upstreamRelease.publicationArtifact.version"),
    canonicalUrl: assertString(
      artifact.canonicalUrl || artifact.canonical_url,
      "upstreamRelease.publicationArtifact.canonicalUrl",
    ),
    latestUrl: assertString(
      artifact.latestUrl || artifact.latest_url,
      "upstreamRelease.publicationArtifact.latestUrl",
    ),
    latestEvidenceUrl: optionalString(artifact.latestEvidenceUrl || artifact.latest_evidence_url),
    immutableVersionUrl: assertString(
      artifact.immutableVersionUrl || artifact.immutable_version_url || artifact.immutableVersionPrefix || artifact.immutable_version_prefix,
      "upstreamRelease.publicationArtifact.immutableVersionUrl",
    ),
    immutableVersionPrefix: optionalString(artifact.immutableVersionPrefix || artifact.immutable_version_prefix),
    registry: normalizeDigestUrlFact(artifact.registry, "upstreamRelease.publicationArtifact.registry"),
    manifest: normalizeDigestUrlFact(artifact.manifest, "upstreamRelease.publicationArtifact.manifest"),
    passport: normalizeDigestUrlFact(artifact.passport, "upstreamRelease.publicationArtifact.passport"),
    primaryArtifact: normalizeOptionalPathDigestUrlFact(
      artifact.primaryArtifact || artifact.primary_artifact,
      "upstreamRelease.publicationArtifact.primaryArtifact",
    ),
    sourceBundle: normalizeOptionalPathDigestUrlFact(
      artifact.sourceBundle || artifact.source_bundle,
      "upstreamRelease.publicationArtifact.sourceBundle",
    ),
  };
}

function normalizeUpstreamRelease(input) {
  const release = assertPlainObject(input, "upstreamRelease");
  const publicationArtifact = normalizePublicationArtifactFact(release.publicationArtifact || release.publication_artifact);
  const packageFact = release.package === undefined ? undefined : normalizePackageFact(release.package);
  if (!packageFact && !publicationArtifact) {
    throw new Error("upstreamRelease requires package or publicationArtifact");
  }
  return {
    repository: assertString(release.repository, "upstreamRelease.repository"),
    channel: normalizeChannel(release.channel, "upstreamRelease.channel"),
    tag: assertString(release.tag, "upstreamRelease.tag"),
    sourceSha: assertString(release.sourceSha || release.source_sha, "upstreamRelease.sourceSha"),
    package: packageFact,
    publicationArtifact,
    releasePassport: normalizeReleasePassport(release.releasePassport || release.release_passport),
    siteBundle: release.siteBundle || release.site_bundle
      ? {
        manifestSha256: assertString(
          release.siteBundle?.manifestSha256 || release.site_bundle?.manifest_sha256,
          "upstreamRelease.siteBundle.manifestSha256",
        ),
      }
      : undefined,
  };
}

export function createReleasePropagationLock({
  graph,
  edge,
  sourceNode,
  targetNode,
  upstreamRelease,
  downstreamChannel,
} = {}) {
  const lock = {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_LOCK_CONTRACT,
    upstream: {
      node: sourceNode.id,
      repository: upstreamRelease.repository,
      channel: upstreamRelease.channel,
      tag: upstreamRelease.tag,
      sourceSha: upstreamRelease.sourceSha,
      package: upstreamRelease.package,
      publicationArtifact: upstreamRelease.publicationArtifact,
      releasePassport: upstreamRelease.releasePassport,
      siteBundle: upstreamRelease.siteBundle,
    },
    downstream: {
      node: targetNode.id,
      repository: targetNode.repository,
      channel: downstreamChannel,
      baseRef: edge.prBaseRef || targetNode.baseRef,
      lockPath: edge.lockPath || targetNode.lockPath || ".buildchain/upstream-release.lock.json",
    },
    propagation: {
      graphContract: graph.contract,
      edge: edge.id,
      channelPolicy: edge.channelPolicy,
      channelMap: edge.channelMap,
      exact: true,
      floatingTags: false,
    },
  };
  lock.lockSha256 = sha256Json({ ...lock, lockSha256: undefined });
  return lock;
}

export function planReleasePropagation({ graph: graphInput, upstreamRelease: releaseInput, sourceNode = "" } = {}) {
  const graph = normalizeReleasePropagationGraph(graphInput);
  const upstreamRelease = normalizeUpstreamRelease(releaseInput);
  const source = sourceNode
    ? graph.nodes.find((node) => node.id === sourceNode)
    : graph.nodes.find((node) =>
        node.repository === upstreamRelease.repository
        || (upstreamRelease.package && node.package === upstreamRelease.package.name),
      );
  if (!source) {
    throw new Error("could not resolve source node for upstream release");
  }
  const targets = [];
  for (const edge of graph.edges.filter((entry) => entry.from === source.id)) {
    const downstreamChannel = resolvePropagationChannel(edge, upstreamRelease.channel);
    if (!downstreamChannel) {
      continue;
    }
    const target = graph.nodes.find((node) => node.id === edge.to);
    const lock = createReleasePropagationLock({
      graph,
      edge,
      sourceNode: source,
      targetNode: target,
      upstreamRelease,
      downstreamChannel,
    });
    targets.push({
      edge: edge.id,
      source: source.id,
      target: target.id,
      repository: target.repository,
      channel: downstreamChannel,
      baseRef: lock.downstream.baseRef,
      lockPath: lock.downstream.lockPath,
      lock,
    });
  }
  return {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_PLAN_CONTRACT,
    source: source.id,
    upstreamRelease,
    targets,
    summary: {
      targetCount: targets.length,
      channels: [...new Set(targets.map((target) => target.channel))],
      repositories: targets.map((target) => target.repository),
    },
  };
}

export function readReleasePropagationJson(value, { cwd = process.cwd(), label = "json" } = {}) {
  const source = String(value || "").trim();
  if (!source) {
    throw new Error(`${label} is required`);
  }
  const candidatePath = path.isAbsolute(source) ? source : path.join(cwd, source);
  if (fs.existsSync(candidatePath)) {
    return JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  }
  return JSON.parse(source);
}

export function writeReleasePropagationLock({ plan, target = "", cwd = process.cwd(), output = "" } = {}) {
  assertPlainObject(plan, "plan");
  const matches = plan.targets.filter((entry) => !target || entry.target === target || entry.repository === target);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one propagation target, found ${matches.length}`);
  }
  const selected = matches[0];
  const outputPath = path.resolve(cwd, output || selected.lockPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, stableJson(selected.lock));
  return {
    target: selected.target,
    repository: selected.repository,
    channel: selected.channel,
    path: outputPath,
    lockSha256: selected.lock.lockSha256,
  };
}
