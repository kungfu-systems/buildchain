import {
  assertCommitSha,
} from "./release-propagation-work-control.js";
import {
  assertExactFields,
  assertPlainObject,
  assertString,
} from "./release-propagation-common.js";
import {
  createReleasePropagationWork,
  normalizeReleasePropagationGraph,
  planReleasePropagation,
  verifyReleasePropagationWork,
} from "./release-propagation.js";
import { normalizeUpstreamRelease } from "./release-propagation-release.js";

export const PACKAGE_RELEASE_PROPAGATION_CONFIG_CONTRACT =
  "kungfu-buildchain-package-release-propagation";

function assertAllowedFields(value, allowed, required, label) {
  const object = assertPlainObject(value, label);
  const unknown = Object.keys(object).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown fields: ${unknown.sort().join(", ")}`);
  }
  for (const field of required) {
    if (!(field in object)) throw new Error(`${label}.${field} is required`);
  }
  return object;
}

function assertStrictGraph(graph) {
  const value = assertAllowedFields(
    graph,
    new Set(["schemaVersion", "contract", "channelPolicy", "nodes", "edges"]),
    ["schemaVersion", "contract", "nodes", "edges"],
    "package release propagation config graph",
  );
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("package release propagation config graph nodes and edges must be arrays");
  }
  value.nodes.forEach((node, index) => assertAllowedFields(
    node,
    new Set([
      "id", "repository", "package", "lockPath", "baseRef", "workflow",
      "executionProfile",
    ]),
    ["id", "repository"],
    `package release propagation config graph nodes[${index}]`,
  ));
  value.edges.forEach((edge, index) => assertAllowedFields(
    edge,
    new Set([
      "id", "from", "to", "channels", "channelPolicy", "channelMap",
      "lockPath", "prBaseRef",
    ]),
    ["from", "to"],
    `package release propagation config graph edges[${index}]`,
  ));
  return normalizeReleasePropagationGraph(value);
}

export function normalizePackageReleasePropagationConfig(input) {
  const config = assertExactFields(input, [
    "schemaVersion", "contract", "sourceNode", "graph", "targets",
  ], "package release propagation config");
  if (config.schemaVersion !== 1 || config.contract !== PACKAGE_RELEASE_PROPAGATION_CONFIG_CONTRACT) {
    throw new Error(`package release propagation config must use ${PACKAGE_RELEASE_PROPAGATION_CONFIG_CONTRACT} v1`);
  }
  const sourceNode = assertString(config.sourceNode, "package release propagation config sourceNode");
  if (!/^[A-Za-z0-9._-]+$/.test(sourceNode)) {
    throw new Error("package release propagation config sourceNode must be a canonical node id");
  }
  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    throw new Error("package release propagation config targets must be a non-empty array");
  }
  const targets = config.targets.map((target, index) => {
    const value = assertString(target, `package release propagation config targets[${index}]`);
    if (!/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error("package release propagation config targets must be canonical node ids");
    }
    return value;
  });
  const canonicalTargets = [...new Set(targets)].sort();
  if (JSON.stringify(targets) !== JSON.stringify(canonicalTargets)) {
    throw new Error("package release propagation config targets must be sorted and unique");
  }
  const graph = assertStrictGraph(config.graph);
  const source = graph.nodes.find((node) => node.id === sourceNode);
  if (!source) throw new Error("package release propagation config sourceNode is absent from graph");
  if (!source.package) throw new Error("package release propagation source node must declare a package");
  return {
    schemaVersion: 1,
    contract: PACKAGE_RELEASE_PROPAGATION_CONFIG_CONTRACT,
    sourceNode,
    graph,
    targets: canonicalTargets,
  };
}

export function createPackageReleasePropagationCapture({
  config: configInput,
  upstreamRelease: upstreamReleaseInput,
  expectedBaseShas = {},
} = {}) {
  const config = normalizePackageReleasePropagationConfig(configInput);
  const upstreamRelease = normalizeUpstreamRelease(upstreamReleaseInput);
  const source = config.graph.nodes.find((node) => node.id === config.sourceNode);
  if (source.repository !== upstreamRelease.repository) {
    throw new Error("package release propagation source repository disagrees with release envelope");
  }
  if (source.package !== upstreamRelease.package?.name) {
    throw new Error("package release propagation source package disagrees with release envelope");
  }
  const plan = planReleasePropagation({
    graph: config.graph,
    upstreamRelease,
    sourceNode: config.sourceNode,
  });
  const plannedTargets = plan.targets.map((target) => target.target).sort();
  if (JSON.stringify(plannedTargets) !== JSON.stringify(config.targets)) {
    throw new Error("package release propagation targets must exactly match the release-channel plan");
  }
  const works = plan.targets.map((target) => {
    const expectedBaseSha = expectedBaseShas[target.target]
      || expectedBaseShas[target.repository]
      || "";
    assertCommitSha(
      expectedBaseSha,
      `expected downstream base SHA for ${target.target}`,
    );
    const work = createReleasePropagationWork({
      plan,
      target: target.target,
      expectedDownstreamBaseSha: expectedBaseSha,
    });
    const status = verifyReleasePropagationWork(work);
    if (status.lifecycle !== "paused" || status.nextAction?.action !== "claim") {
      throw new Error("captured package propagation work must remain paused at claim");
    }
    return {
      target: target.target,
      repository: target.repository,
      propagationKey: target.propagationKey,
      work,
      status,
    };
  });
  return { config, upstreamRelease, plan, works };
}
