import fs from "node:fs";
import path from "node:path";
import {
  assertPlainObject,
  assertString,
  RELEASE_PROPAGATION_PLAN_CONTRACT,
  normalizeChannel,
  optionalString,
  sha256Json,
  stableJson,
} from "./release-propagation-common.js";
import { normalizeExecutionProfile } from "./release-propagation-execution-profile.js";
import { normalizeUpstreamRelease } from "./release-propagation-release.js";

export const RELEASE_PROPAGATION_GRAPH_CONTRACT = "kungfu-buildchain-release-propagation-graph";
export { RELEASE_PROPAGATION_PLAN_CONTRACT };
export const RELEASE_PROPAGATION_LOCK_CONTRACT = "kungfu-buildchain-release-propagation-lock";
export const RELEASE_PROPAGATION_RECEIPT_CONTRACT = "kungfu-buildchain-release-propagation-receipt";
const SUPPORTED_CHANNEL_POLICIES = new Set(["preserve", "explicit"]);

function releaseVersion(upstreamRelease) {
  return upstreamRelease.package?.version || upstreamRelease.publicationArtifact?.version || "";
}

function safeBranchPart(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error(`release propagation branch component is empty: ${value}`);
  }
  return normalized;
}

function releaseIdentity(upstreamRelease) {
  const version = releaseVersion(upstreamRelease);
  if (!version) {
    throw new Error("upstream release does not expose a package or publication version");
  }
  return {
    repository: upstreamRelease.repository,
    version,
    channel: upstreamRelease.channel,
  };
}

function propagationIdentity({ upstreamRelease, targetNode }) {
  return {
    release: releaseIdentity(upstreamRelease),
    downstreamRepository: targetNode.repository,
  };
}

function propagationBranch({ upstreamRelease, targetNode }) {
  const identity = propagationIdentity({ upstreamRelease, targetNode });
  const digest = sha256Json(identity).slice(0, 12);
  const repository = safeBranchPart(upstreamRelease.repository.replace("/", "-"));
  const version = safeBranchPart(releaseVersion(upstreamRelease));
  return `buildchain/release-propagation/${repository}/${version}-${upstreamRelease.channel}-${digest}`;
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
    executionProfile: normalizeExecutionProfile(node.executionProfile || node.execution_profile, `nodes[${index}].executionProfile`),
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

export function createReleasePropagationLock({
  graph,
  edge,
  sourceNode,
  targetNode,
  upstreamRelease,
  downstreamChannel,
} = {}) {
  const identity = propagationIdentity({ upstreamRelease, targetNode });
  const propagationKey = sha256Json(identity);
  const lock = {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_LOCK_CONTRACT,
    upstream: {
      node: sourceNode.id,
      repository: upstreamRelease.repository,
      channel: upstreamRelease.channel,
      tag: upstreamRelease.tag,
      tagTargetSha: upstreamRelease.tagTargetSha,
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
      executionProfile: targetNode.executionProfile,
    },
    propagation: {
      graphContract: graph.contract,
      edge: edge.id,
      channelPolicy: edge.channelPolicy,
      channelMap: edge.channelMap,
      releaseIdentity: identity.release,
      propagationKey,
      branch: propagationBranch({ upstreamRelease, targetNode }),
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
      executionProfile: lock.downstream.executionProfile,
      propagationKey: lock.propagation.propagationKey,
      branch: lock.propagation.branch,
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
      releaseIdentity: releaseIdentity(upstreamRelease),
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
  const rendered = stableJson(selected.lock);
  const previous = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (previous !== rendered) {
    fs.writeFileSync(outputPath, rendered);
  }
  return {
    target: selected.target,
    repository: selected.repository,
    channel: selected.channel,
    path: outputPath,
    lockSha256: selected.lock.lockSha256,
    propagationKey: selected.propagationKey || selected.lock.propagation?.propagationKey || "",
    branch: selected.branch || selected.lock.propagation?.branch || "",
    status: previous === rendered ? "reused" : "written",
    changed: previous !== rendered,
  };
}

const RECEIPT_VISIBILITY_STATES = new Set(["pending", "visible", "failed", "not-requested"]);
const RECEIPT_PR_STATES = new Set(["planned", "created", "updated", "reused", "no-change", "failed"]);

function receiptVisibilityState(value, label) {
  const state = optionalString(value) || "pending";
  if (!RECEIPT_VISIBILITY_STATES.has(state)) {
    throw new Error(`${label} must be pending, visible, failed, or not-requested`);
  }
  return state;
}

function receiptPrOutcome(value = {}) {
  const outcome = assertPlainObject(value, "release propagation PR outcome");
  const state = optionalString(outcome.state) || "planned";
  if (!RECEIPT_PR_STATES.has(state)) {
    throw new Error("release propagation PR outcome state is unsupported");
  }
  return {
    state,
    number: outcome.number === undefined || outcome.number === null || outcome.number === ""
      ? null
      : Number(outcome.number),
    url: optionalString(outcome.url),
    branch: assertString(outcome.branch, "release propagation PR outcome branch"),
  };
}

export function createReleasePropagationReceipt({
  plan,
  target = "",
  lockResult,
  prOutcome,
  stagingState = "pending",
  productionState = "not-requested",
  observedAt = "",
} = {}) {
  const selectedPlan = assertPlainObject(plan, "plan");
  const matches = selectedPlan.targets.filter((entry) =>
    !target || entry.target === target || entry.repository === target);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one propagation target, found ${matches.length}`);
  }
  const selected = matches[0];
  const result = assertPlainObject(lockResult, "release propagation lock result");
  if (result.lockSha256 !== selected.lock.lockSha256) {
    throw new Error("release propagation receipt lock result does not match the plan");
  }
  const propagationKey = selected.propagationKey || selected.lock.propagation?.propagationKey || "";
  if (result.propagationKey && result.propagationKey !== propagationKey) {
    throw new Error("release propagation receipt key does not match the lock result");
  }
  const branch = selected.branch || selected.lock.propagation?.branch || "";
  const normalizedPr = receiptPrOutcome({ ...prOutcome, branch: prOutcome?.branch || branch });
  if (normalizedPr.branch !== branch) {
    throw new Error("release propagation PR branch does not match the exact plan");
  }
  const upstreamRelease = selectedPlan.upstreamRelease;
  const release = releaseIdentity(upstreamRelease);
  const states = {
    "package-published": {
      state: upstreamRelease.package ? "complete" : "not-applicable",
      evidence: upstreamRelease.package
        ? {
            name: upstreamRelease.package.name,
            version: upstreamRelease.package.version,
            integrity: upstreamRelease.package.integrity,
            gitHead: upstreamRelease.package.gitHead,
          }
        : null,
    },
    "alpha-complete": {
      state: release.channel === "alpha" ? "complete" : "not-applicable",
      evidence: release.channel === "alpha"
        ? {
            releasePassportSha256: upstreamRelease.releasePassport.sha256,
            tag: upstreamRelease.tag,
          }
        : null,
    },
    "staging-visible": {
      state: receiptVisibilityState(stagingState, "stagingState"),
    },
    "production-visible": {
      state: receiptVisibilityState(productionState, "productionState"),
    },
  };
  const body = {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_RECEIPT_CONTRACT,
    propagationKey,
    observedAt: optionalString(observedAt),
    release,
    upstream: {
      repository: upstreamRelease.repository,
      tag: upstreamRelease.tag,
      tagTargetSha: upstreamRelease.tagTargetSha,
      sourceSha: upstreamRelease.sourceSha,
      releasePassport: upstreamRelease.releasePassport,
    },
    downstream: {
      repository: selected.repository,
      channel: selected.channel,
      baseRef: selected.baseRef,
      lockPath: selected.lockPath,
      lockSha256: result.lockSha256,
      lockWriteState: result.status || (result.changed === false ? "reused" : "written"),
      pullRequest: normalizedPr,
    },
    states,
  };
  return {
    ...body,
    receiptSha256: sha256Json(body),
  };
}

export {
  RELEASE_PROPAGATION_STAGE_RECEIPT_CONTRACT,
  RELEASE_PROPAGATION_WORK_CONTRACT,
  RELEASE_PROPAGATION_WORK_STAGES,
  createReleasePropagationStageReceipt,
  createReleasePropagationWork,
  resumeReleasePropagationWork,
  verifyReleasePropagationWork,
} from "./release-propagation-work.js";
export {
  claimReleasePropagationWork,
  completeReleasePropagationWork,
  recordReleasePropagationStage,
  repairReleasePropagationWork,
} from "./release-propagation-work-transitions.js";
export {
  PACKAGE_RELEASE_PROPAGATION_CONFIG_CONTRACT,
  createPackageReleasePropagationCapture,
  normalizePackageReleasePropagationConfig,
} from "./release-propagation-capture.js";
