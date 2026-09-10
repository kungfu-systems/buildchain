import { resolveBuildchainChannel } from "../../consumer/channel-selection.js";
import { parseBuildchainRefIdentity } from "../../consumer/buildchain-channel-identity.js";
const TARGETS = [
  {
    pattern: /^alpha\/v(\d+)\/v\d+\.\d+$/,
    publicationChannel: "alpha",
    shellChannel: "alpha",
  },
  {
    pattern: /^release\/v(\d+)\/v\d+\.\d+$/,
    publicationChannel: "release",
    shellChannel: "stable",
  },
  {
    pattern: /^publish-gate\/major$/,
    publicationChannel: "major",
    shellChannel: "stable",
  },
];

function normalized(value) {
  return String(value ?? "").trim();
}

function sameExactSha(left, right) {
  const first = normalized(left).toLowerCase();
  const second = normalized(right).toLowerCase();
  return /^[0-9a-f]{40}$/.test(first) && first === second;
}

function targetIntent(targetRef, requestedPublicationChannel = "") {
  const ref = normalized(targetRef).replace(/^refs\/heads\//, "");
  const target = TARGETS.find((entry) => entry.pattern.test(ref));
  if (!target)
    throw new Error(`unsupported promotion target ref: ${ref || "<empty>"}`);
  const requested = normalized(requestedPublicationChannel).toLowerCase();
  if (requested && requested !== target.publicationChannel) {
    throw new Error(
      `promotion channel ${requested} does not match target ref ${ref} (${target.publicationChannel})`,
    );
  }
  return {
    targetRef: ref,
    publicationChannel: target.publicationChannel,
    shellChannel: target.shellChannel,
  };
}

export function resolvePromotionChannel({
  requestedChannel = "auto",
  requestedRef = "",
  publicationChannel = "",
  targetRef = "",
  routerRef = "",
  routerSha = "",
  packageVersion = "",
} = {}) {
  const intent = targetIntent(targetRef, publicationChannel);
  const selected = resolveBuildchainChannel({
    requestedChannel,
    requestedRef,
    publishChannel: intent.publicationChannel,
    eventName: "workflow_call",
    routerRef,
    packageVersion,
  });
  const runtimeIdentity = parseBuildchainRefIdentity(selected.buildchainRef);
  const opaqueOverride = new Set(["train", "authority", "exact-sha"]).has(
    runtimeIdentity.kind,
  );
  const trustedRouterPin =
    opaqueOverride && sameExactSha(selected.buildchainRef, routerSha);
  const overrideUsed = opaqueOverride && !trustedRouterPin;
  if (
    !overrideUsed &&
    !trustedRouterPin &&
    selected.channel !== intent.shellChannel
  ) {
    throw new Error(
      `promotion target ${intent.targetRef} requires ${intent.shellChannel} shell/runtime, got ${selected.channel}`,
    );
  }
  const shellRef =
    intent.shellChannel === "alpha"
      ? `v${selected.major}-alpha`
      : `v${selected.major}`;
  return {
    targetRef: intent.targetRef,
    publicationChannel: intent.publicationChannel,
    routerRef: normalized(routerRef),
    routerSha: normalized(routerSha).toLowerCase(),
    channel: intent.shellChannel,
    major: selected.major,
    shellRef,
    runtimeRef: selected.buildchainRef,
    overrideUsed,
    selectionSource: trustedRouterPin
      ? "trusted-router-sha"
      : selected.selectionSource,
    reason: trustedRouterPin
      ? `explicit Buildchain runtime ref ${selected.buildchainRef} matches the reusable workflow SHA`
      : selected.reason,
  };
}
