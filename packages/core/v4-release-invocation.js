import {
  V4ContractFault,
  v4CanonicalBytes,
  v4ContentRoot,
  validateV4Root,
} from "./v4-canonical-contracts.js";

export const V4_RELEASE_INVOCATION_CONTRACT =
  "kungfu-buildchain-v4-release-invocation/v1";
export const V4_RELEASE_INVOCATION_ADAPTER_CONTRACT =
  "kungfu-buildchain-v4-release-invocation-adapter/v1";
export const V4_RELEASE_TRANSACTION_CONTRACT =
  "kungfu-buildchain-v4-release-transaction/v1";
export const V4_RELEASE_RECEIPT_CONTRACT =
  "kungfu-buildchain-v4-release-receipt/v1";
export const V4_RELEASE_PROVIDER_CONTRACT =
  "kungfu-buildchain-release-tail-provider/v1";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const ROUTE_SURFACES = new Set([
  "alpha",
  "stable",
  "public",
  "private",
  "declarative",
  "legacy-compatible",
]);
const EXECUTION_MODES = new Set(["fresh", "resume"]);
const COMPARISON_STATES = new Set(["identical", "ahead", "behind", "diverged"]);

function fault(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("invalid-release-invocation", path, `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fault(
      "invalid-release-invocation-shape",
      path,
      `${path} keys are not canonical`,
    );
}

function sha(value, path, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !SHA_PATTERN.test(value))
    fault("invalid-release-sha", path, `${path} must be an exact Git SHA`);
  return value;
}

function text(value, path) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[^\x20-\x7e]/u.test(value)
  )
    fault("invalid-release-text", path, `${path} must be printable ASCII`);
  return value;
}

function validatePublisher(value) {
  exactKeys(
    value,
    ["repository", "workflow", "workflowSha", "job"],
    "$/publisher",
  );
  if (
    value.repository !== "kungfu-systems/buildchain" ||
    value.workflow !== ".github/workflows/.release-candidate-promote.yml" ||
    value.job !== "apply"
  )
    fault(
      "invalid-publisher-identity",
      "$/publisher",
      "publisher identity is not the canonical v4 APPLY job",
    );
  sha(value.workflowSha, "$/publisher/workflowSha");
}

function validateRuntime(value) {
  exactKeys(value, ["repository", "commit", "tree"], "$/runtime");
  if (value.repository !== "kungfu-systems/buildchain")
    fault(
      "invalid-runtime-identity",
      "$/runtime/repository",
      "runtime repository is not canonical",
    );
  sha(value.commit, "$/runtime/commit");
  sha(value.tree, "$/runtime/tree");
}

function validateCandidate(value) {
  exactKeys(value, ["repository", "commit", "tree", "version"], "$/candidate");
  text(value.repository, "$/candidate/repository");
  sha(value.commit, "$/candidate/commit");
  sha(value.tree, "$/candidate/tree");
  text(value.version, "$/candidate/version");
}

function validateTarget(value) {
  exactKeys(value, ["channel", "tag", "expectedOldSha"], "$/target");
  if (
    !["alpha", "stable"].includes(value.channel) ||
    !TAG_PATTERN.test(value.tag)
  )
    fault(
      "invalid-release-target",
      "$/target",
      "release channel and exact tag are not canonical",
    );
  sha(value.expectedOldSha, "$/target/expectedOldSha", true);
}

function validateAuthority(value) {
  exactKeys(
    value,
    ["policyRoot", "qualificationRoot", "warrantRoot"],
    "$/authority",
  );
  for (const name of ["policyRoot", "qualificationRoot", "warrantRoot"])
    validateV4Root(value[name], `$/authority/${name}`);
}

function validateProvider(value, candidate) {
  exactKeys(value, ["adapter", "contract", "repository"], "$/provider");
  if (
    value.adapter !== "built-in-provider-plane" ||
    value.contract !== V4_RELEASE_PROVIDER_CONTRACT ||
    value.repository !== candidate.repository
  )
    fault(
      "invalid-release-provider",
      "$/provider",
      "provider identity must bind the built-in Provider Plane and candidate repository",
    );
}

function validateParent(value) {
  exactKeys(
    value,
    ["invocationRoot", "transactionRoot", "receiptRoot"],
    "$/parent",
  );
  const roots = [
    value.invocationRoot,
    value.transactionRoot,
    value.receiptRoot,
  ];
  if (roots.every((root) => root === null)) return;
  if (roots.some((root) => root === null))
    fault(
      "invalid-release-parent-lineage",
      "$/parent",
      "parent lineage roots must be either all null or all present",
    );
  roots.forEach((root, index) =>
    validateV4Root(
      root,
      `$/parent/${["invocationRoot", "transactionRoot", "receiptRoot"][index]}`,
    ),
  );
}

export function createV4ReleaseInvocation(value) {
  exactKeys(
    value,
    [
      "schema",
      "publisher",
      "runtime",
      "candidate",
      "target",
      "authority",
      "provider",
      "parent",
    ],
    "$",
  );
  if (value.schema !== V4_RELEASE_INVOCATION_CONTRACT)
    fault(
      "invalid-release-invocation",
      "$/schema",
      "unsupported invocation schema",
    );
  validatePublisher(value.publisher);
  validateRuntime(value.runtime);
  validateCandidate(value.candidate);
  validateTarget(value.target);
  validateAuthority(value.authority);
  validateProvider(value.provider, value.candidate);
  validateParent(value.parent);
  v4CanonicalBytes(value);
  const roots = {
    publisherRoot: v4ContentRoot(
      "release-invocation-publisher",
      value.publisher,
    ),
    runtimeRoot: v4ContentRoot("release-invocation-runtime", value.runtime),
    candidateRoot: v4ContentRoot(
      "release-invocation-candidate",
      value.candidate,
    ),
    targetRoot: v4ContentRoot("release-invocation-target", value.target),
    authorityRoot: v4ContentRoot(
      "release-invocation-authority",
      value.authority,
    ),
    providerRoot: v4ContentRoot("release-invocation-provider", value.provider),
    parentRoot: v4ContentRoot("release-invocation-parent", value.parent),
  };
  const invocationRoot = v4ContentRoot("release-invocation", {
    schema: V4_RELEASE_INVOCATION_CONTRACT,
    ...roots,
  });
  return { invocation: value, roots: { ...roots, invocationRoot } };
}

export function adaptV4ReleaseInvocation(value) {
  exactKeys(value, ["schema", "route", "invocation"], "$adapter");
  if (value.schema !== V4_RELEASE_INVOCATION_ADAPTER_CONTRACT)
    fault(
      "invalid-release-adapter",
      "$adapter/schema",
      "unsupported adapter schema",
    );
  exactKeys(value.route, ["surface", "execution"], "$adapter/route");
  if (!ROUTE_SURFACES.has(value.route.surface))
    fault(
      "invalid-release-adapter",
      "$adapter/route/surface",
      "unsupported route surface",
    );
  if (!EXECUTION_MODES.has(value.route.execution))
    fault(
      "invalid-release-adapter",
      "$adapter/route/execution",
      "unsupported execution mode",
    );
  return createV4ReleaseInvocation(value.invocation);
}

export function planV4ReleaseRoute({
  requestedSha,
  observedSha,
  comparisonStatus,
  requestedChannel = "",
  targetRef,
  dryRun = false,
  resume = false,
}) {
  sha(requestedSha, "$route/requestedSha");
  sha(observedSha, "$route/observedSha");
  if (!COMPARISON_STATES.has(comparisonStatus))
    fault(
      "invalid-release-route",
      "$route/comparisonStatus",
      "unsupported source comparison state",
    );
  text(targetRef, "$route/targetRef");
  const alphaLane = /^alpha\/v[0-9]+\/v[0-9]+\.[0-9]+$/u.test(targetRef);
  const stableLane =
    /^release\/v[0-9]+\/v[0-9]+\.[0-9]+$/u.test(targetRef) ||
    ["publish-gate/major", "major-gate"].includes(targetRef);
  if (!alphaLane && !stableLane)
    fault(
      "invalid-release-route",
      "$route/targetRef",
      "source lane is not a supported v4 release lane",
    );
  const derivedChannel = alphaLane ? "alpha" : "stable";
  const normalizedRequested =
    requestedChannel === "alpha"
      ? "alpha"
      : ["release", "stable", "major"].includes(requestedChannel)
        ? "stable"
        : requestedChannel === ""
          ? derivedChannel
          : "";
  if (!normalizedRequested || normalizedRequested !== derivedChannel)
    fault(
      "invalid-release-route",
      "$route/channel",
      "requested channel does not match the source lane",
    );
  let decision = resume ? "Resume" : "Fresh";
  let reason = resume ? "resume" : "fresh";
  if (comparisonStatus === "ahead" && !resume && !dryRun) {
    decision = "NoOp";
    reason = "source-advanced";
  } else if (
    requestedSha !== observedSha &&
    !(resume && comparisonStatus === "ahead") &&
    !(dryRun && comparisonStatus === "ahead")
  ) {
    decision = "Blocked";
    reason = `source-${comparisonStatus}`;
  }
  return Object.freeze({
    decision,
    reason,
    channel: normalizedRequested,
    targetRef,
    requestedSha,
    observedSha,
  });
}

export function createV4ReleaseTransaction(value) {
  exactKeys(
    value,
    [
      "invocationRoot",
      "publisherRoot",
      "runtimeRoot",
      "providerRoot",
      "parentRoot",
    ],
    "$transaction",
  );
  for (const name of [
    "invocationRoot",
    "publisherRoot",
    "runtimeRoot",
    "providerRoot",
    "parentRoot",
  ])
    validateV4Root(value[name], `$transaction/${name}`);
  const transaction = {
    schema: V4_RELEASE_TRANSACTION_CONTRACT,
    invocationRoot: value.invocationRoot,
    publisherRoot: value.publisherRoot,
    runtimeRoot: value.runtimeRoot,
    providerRoot: value.providerRoot,
    parentRoot: value.parentRoot,
    phases: ["QUALIFY", "APPLY", "SETTLE"],
    writer: "canonical-v4-apply",
  };
  return {
    transaction,
    transactionRoot: v4ContentRoot("release-transaction", transaction),
  };
}

export function createV4ReleaseReceipt(value) {
  exactKeys(
    value,
    [
      "schema",
      "transactionRoot",
      "outcome",
      "releasePassportRoot",
      "providerTransactionRoot",
      "providerStateRoot",
      "providerReceiptRoots",
    ],
    "$receipt",
  );
  if (value.schema !== V4_RELEASE_RECEIPT_CONTRACT)
    fault(
      "invalid-release-receipt",
      "$receipt/schema",
      "unsupported receipt schema",
    );
  validateV4Root(value.transactionRoot, "$receipt/transactionRoot");
  if (!["complete", "blocked"].includes(value.outcome))
    fault(
      "invalid-release-receipt",
      "$receipt/outcome",
      "unsupported receipt outcome",
    );
  for (const name of [
    "releasePassportRoot",
    "providerTransactionRoot",
    "providerStateRoot",
  ]) {
    if (value[name] !== null) validateV4Root(value[name], `$receipt/${name}`);
  }
  if (!Array.isArray(value.providerReceiptRoots))
    fault(
      "invalid-release-receipt",
      "$receipt/providerReceiptRoots",
      "receipt roots must be an array",
    );
  value.providerReceiptRoots.forEach((root, index) =>
    validateV4Root(root, `$receipt/providerReceiptRoots/${index}`),
  );
  const canonicalRoots = [...new Set(value.providerReceiptRoots)].sort();
  if (
    canonicalRoots.length !== value.providerReceiptRoots.length ||
    canonicalRoots.some(
      (root, index) => root !== value.providerReceiptRoots[index],
    )
  )
    fault(
      "invalid-release-receipt",
      "$receipt/providerReceiptRoots",
      "provider receipt roots must be sorted and unique",
    );
  if (
    value.outcome === "complete" &&
    [
      value.releasePassportRoot,
      value.providerTransactionRoot,
      value.providerStateRoot,
    ].some((root) => root === null)
  )
    fault(
      "invalid-release-receipt",
      "$receipt/outcome",
      "complete receipt requires every terminal root",
    );
  v4CanonicalBytes(value);
  return {
    receipt: value,
    receiptRoot: v4ContentRoot("release-receipt", value),
  };
}
