import { v4ContentRoot, validateV4Root } from "./v4-canonical-contracts.js";
import {
  RELEASE_TAIL_DECLARATION_CONTRACT,
  RELEASE_TAIL_EFFECT_SCHEMA,
  RELEASE_TAIL_OBSERVATION_SCHEMA,
  RELEASE_TAIL_RECEIPT_SCHEMA,
  RELEASE_TAIL_TRANSACTION_POLICY,
} from "./release-tail-provider-plane.js";
import { RELEASE_TAIL_PRODUCT_CAPABILITIES } from "./release-tail-product-capabilities.js";

export const V4_PRODUCT_PUBLICATION_INTENT_CONTRACT =
  "kungfu-buildchain-v4-product-publication-intent/v1";
export const V4_PRODUCT_PUBLICATION_PLAN_CONTRACT =
  "kungfu-buildchain-v4-product-publication-plan/v1";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/u;
const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;

function fail(message) {
  throw new Error(`invalid v4 product publication: ${message}`);
}

function parseVersion(value, label) {
  const normalized = String(value || "").trim();
  const match = normalized.match(VERSION);
  if (!match) fail(`${label} must be an exact stable or alpha version`);
  return {
    value: normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    alpha: match[4] === undefined ? null : Number(match[4]),
  };
}

function channelName(value) {
  if (value === "alpha") return "alpha";
  if (["release", "stable", "major"].includes(value)) return "stable";
  fail(`unsupported channel '${value}'`);
}

function publicationArtifactKind(value) {
  if (!value || value === "npm") return "npm";
  if (value === "custom") return "custom";
  fail(`unsupported artifactKind '${value}'`);
}

function publicationProductCoordinates({
  artifactKind,
  packageName,
  distTag,
  sealedBundleRoot,
}) {
  if (artifactKind === "custom") return { artifactKind };
  const normalizedDistTag = requiredString(distTag, "distTag");
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalizedDistTag))
    fail("distTag must be an npm dist-tag");
  return {
    packageName: requiredString(packageName, "packageName"),
    distTag: normalizedDistTag,
    sealedBundleRoot: requiredRoot(sealedBundleRoot, "sealedBundleRoot"),
  };
}

function assertLane({ channel, targetRef, version }) {
  const expression =
    channel === "alpha"
      ? /^alpha\/v(\d+)\/v(\d+)\.(\d+)$/u
      : /^release\/v(\d+)\/v(\d+)\.(\d+)$/u;
  const match = String(targetRef || "").match(expression);
  if (!match) fail(`target ref '${targetRef}' is not a ${channel} lane`);
  if (
    Number(match[1]) !== version.major ||
    Number(match[2]) !== version.major ||
    Number(match[3]) !== version.minor
  )
    fail("target ref does not match the publication version line");
}

function observedAlphaNumber(version, expected) {
  const parsed = VERSION.test(version) ? parseVersion(version, "observed") : {};
  return parsed.major === expected.major &&
    parsed.minor === expected.minor &&
    parsed.patch === expected.patch
    ? parsed.alpha
    : null;
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) fail(`${label} must be a non-empty string`);
  return normalized;
}

function requiredRoot(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!ROOT.test(normalized)) fail(`${label} must be a sha256 content root`);
  return normalized;
}

export function selectV4ProductPublicationIntent({
  channel,
  targetRef,
  sourceSha,
  sourceTimestamp,
  repository,
  artifactKind = "npm",
  packageName,
  distTag,
  sealedBundleRoot,
  requiredArtifactsRoot,
  candidateVersion,
  recoveredVersion = "",
  observedVersions = [],
}) {
  const normalizedChannel = channelName(channel);
  if (!SHA.test(String(sourceSha || "")))
    fail("sourceSha must be an exact Git SHA");
  if (!REPOSITORY.test(String(repository || "")))
    fail("repository must be owner/repo");
  const normalizedTimestamp = requiredString(
    sourceTimestamp,
    "sourceTimestamp",
  );
  if (Number.isNaN(Date.parse(normalizedTimestamp)))
    fail("sourceTimestamp must be an ISO timestamp");
  const normalizedArtifactKind = publicationArtifactKind(
    String(artifactKind || "").trim(),
  );
  const productCoordinates = publicationProductCoordinates({
    artifactKind: normalizedArtifactKind,
    packageName,
    distTag,
    sealedBundleRoot,
  });
  if (!Array.isArray(observedVersions))
    fail("observedVersions must be an array");
  const candidate = parseVersion(candidateVersion, "candidateVersion");
  assertLane({ channel: normalizedChannel, targetRef, version: candidate });
  const observed = [...new Set(observedVersions.map(String))].sort();
  let version;
  let mode = "fresh";
  if (String(recoveredVersion || "").trim()) {
    const recovered = parseVersion(recoveredVersion, "recoveredVersion");
    if (
      recovered.major !== candidate.major ||
      recovered.minor !== candidate.minor ||
      recovered.patch !== candidate.patch ||
      (normalizedChannel === "alpha" && recovered.alpha === null) ||
      (normalizedChannel === "stable" && recovered.alpha !== null)
    )
      fail("recoveredVersion is incompatible with the candidate release line");
    version = recovered.value;
    mode = "resume";
  } else if (normalizedChannel === "alpha") {
    if (candidate.alpha === null)
      fail("fresh alpha publication requires an alpha candidate version");
    if (normalizedArtifactKind === "custom") {
      version = candidate.value;
    } else {
      const highest = observed.reduce(
        (current, entry) =>
          Math.max(current, observedAlphaNumber(entry, candidate) ?? -1),
        candidate.alpha,
      );
      version = `${candidate.major}.${candidate.minor}.${candidate.patch}-alpha.${highest + 1}`;
    }
  } else {
    version = `${candidate.major}.${candidate.minor}.${candidate.patch}`;
  }
  const intent = {
    schema: V4_PRODUCT_PUBLICATION_INTENT_CONTRACT,
    mode,
    channel: normalizedChannel,
    targetRef,
    sourceSha,
    sourceTimestamp: new Date(normalizedTimestamp).toISOString(),
    repository,
    ...productCoordinates,
    requiredArtifactsRoot: requiredRoot(
      requiredArtifactsRoot,
      "requiredArtifactsRoot",
    ),
    candidateVersion: candidate.value,
    version,
    exactTag: `v${version}`,
    observedVersions: observed,
  };
  return {
    ...intent,
    intentRoot: v4ContentRoot("v4-product-publication-intent", intent),
  };
}

function alphaReferences(intent, version) {
  const line = `v${version.major}.${version.minor}`;
  return [
    { ref: `refs/tags/${intent.exactTag}`, target: "source" },
    { ref: `refs/heads/${intent.targetRef}`, target: "version-state" },
    {
      ref: `refs/heads/dev/v${version.major}/${line}`,
      target: "version-state",
    },
    { ref: `refs/tags/${line}-alpha`, target: "version-state" },
    { ref: `refs/tags/v${version.major}-alpha`, target: "version-state" },
  ];
}

function stableReferences(intent, version) {
  return [
    { ref: `refs/tags/${intent.exactTag}`, target: "source" },
    { ref: `refs/heads/${intent.targetRef}`, target: "version-state" },
    {
      ref: `refs/tags/v${version.major}.${version.minor}`,
      target: "version-state",
    },
    { ref: `refs/tags/v${version.major}`, target: "version-state" },
  ];
}

export function createV4ProductPublicationPlan({
  intent,
  invocationRoot,
  transactionRoot,
}) {
  validateV4Root(invocationRoot, "$/productPlan/invocationRoot");
  validateV4Root(transactionRoot, "$/productPlan/transactionRoot");
  const selected = selectV4ProductPublicationIntent({
    channel: intent.channel,
    targetRef: intent.targetRef,
    sourceSha: intent.sourceSha,
    sourceTimestamp: intent.sourceTimestamp,
    repository: intent.repository,
    artifactKind: intent.artifactKind,
    packageName: intent.packageName,
    distTag: intent.distTag,
    sealedBundleRoot: intent.sealedBundleRoot,
    requiredArtifactsRoot: intent.requiredArtifactsRoot,
    candidateVersion: intent.candidateVersion,
    recoveredVersion: intent.mode === "resume" ? intent.version : "",
    observedVersions: intent.observedVersions,
  });
  if (selected.intentRoot !== intent.intentRoot)
    fail("intentRoot does not match the canonical publication intent");
  const parsed = parseVersion(intent.version, "intent.version");
  const references =
    intent.channel === "alpha"
      ? alphaReferences(intent, parsed)
      : stableReferences(intent, parsed);
  const stateRef = `refs/heads/buildchain/v4-product-state/${intent.sourceSha}-${intent.version.replaceAll(".", "-")}`;
  const operations = [
    {
      id: "product.version-state.materialize",
      adapter: "github-version-state",
      authority: "contents-write",
      target: {
        repository: intent.repository,
        version: intent.version,
        sourceSha: intent.sourceSha,
        sourceTimestamp: intent.sourceTimestamp,
        stateRef,
      },
    },
    ...(intent.artifactKind === "custom"
      ? []
      : [
          {
            id: "product.package.publish",
            adapter: "npm-trusted-publishing",
            authority: "oidc-provider-mutation",
            target: {
              packageName: intent.packageName,
              version: intent.version,
              distTag: intent.distTag,
              sealedBundleRoot: intent.sealedBundleRoot,
              requiredArtifactsRoot: intent.requiredArtifactsRoot,
            },
          },
        ]),
    {
      id: "product.release-refs.converge",
      adapter: "github-release-refs",
      authority: "contents-write",
      target: {
        repository: intent.repository,
        sourceSha: intent.sourceSha,
        stateRef,
        references,
      },
    },
  ].map((operation) => ({
    ...operation,
    operationRoot: v4ContentRoot("v4-product-publication-operation", operation),
  }));
  const plan = {
    schema: V4_PRODUCT_PUBLICATION_PLAN_CONTRACT,
    intentRoot: intent.intentRoot,
    invocationRoot,
    transactionRoot,
    operationOrder: operations.map(({ id }) => id),
    operations,
  };
  return {
    ...plan,
    planRoot: v4ContentRoot("v4-product-publication-plan", plan),
  };
}

const PRODUCT_CAPABILITIES = Object.fromEntries(
  RELEASE_TAIL_PRODUCT_CAPABILITIES.map((capability) => [
    capability.id,
    {
      ...capability,
      destinationKind:
        capability.id === "product.package.publish"
          ? "npm-package"
          : capability.adapter,
    },
  ]),
);

function exactTagPattern(tag) {
  return `^${tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
}

export function createV4ProductPublicationDeclaration({ intent, plan }) {
  const rebuilt = createV4ProductPublicationPlan({
    intent,
    invocationRoot: plan.invocationRoot,
    transactionRoot: plan.transactionRoot,
  });
  if (rebuilt.planRoot !== plan.planRoot)
    fail("planRoot does not match the canonical publication plan");
  const operationById = new Map(
    plan.operations.map((operation) => [operation.id, operation]),
  );
  return {
    contract: RELEASE_TAIL_DECLARATION_CONTRACT,
    schemaVersion: 1,
    transactionPolicy: RELEASE_TAIL_TRANSACTION_POLICY,
    subject: {
      repository: intent.repository,
      sourceSha: intent.sourceSha,
      version: intent.version,
      tag: intent.exactTag,
      channel: intent.channel,
    },
    capabilities: plan.operationOrder.map((id) => {
      const operation = operationById.get(id);
      const descriptor = PRODUCT_CAPABILITIES[id];
      if (!operation || !descriptor)
        fail(`unsupported product publication operation '${id}'`);
      return {
        id,
        executor: "provider-adapter",
        adapter: operation.adapter,
        artifactRoles: [
          { role: "publication-intent", root: intent.intentRoot },
          ...(id === "product.package.publish"
            ? [
                { role: "sealed-bundle", root: intent.sealedBundleRoot },
                {
                  role: "required-artifacts",
                  root: intent.requiredArtifactsRoot,
                },
              ]
            : []),
        ],
        destination: {
          kind: descriptor.destinationKind,
          locator: `${operation.adapter}:${operation.operationRoot}`,
        },
        channelPolicy: {
          channel: intent.channel,
          tagPattern: exactTagPattern(intent.exactTag),
          authorityMove:
            id === "product.package.publish" ? "none" : "verified-ref",
        },
        activationPolicy: { mode: "none", environment: "none" },
        readbackPredicates: [
          {
            id: `${id}.target-root`,
            kind: "exact-root",
            expected: operation.operationRoot,
          },
        ],
        effect: {
          schema: RELEASE_TAIL_EFFECT_SCHEMA,
          kind: descriptor.effectKind,
        },
        observation: {
          schema: RELEASE_TAIL_OBSERVATION_SCHEMA,
          kind: descriptor.observationKind,
        },
        receipt: {
          schema: RELEASE_TAIL_RECEIPT_SCHEMA,
          kind: descriptor.receiptKind,
        },
        operationIdentity: {
          transactionRoot: plan.transactionRoot,
          capabilityId: id,
          subjectRoot: intent.intentRoot,
          targetRoot: operation.operationRoot,
          attemptKey: `${plan.planRoot}:${id}`,
        },
        idempotency: {
          scope: "subject-target",
          duplicate: "readback-before-retry",
        },
        retry: {
          class: "provider-transient",
          localAttempts: 1,
          exhausted: "blocked",
        },
        evidenceRequirements: [
          "provider readback must match the rooted publication operation",
        ],
      };
    }),
  };
}
