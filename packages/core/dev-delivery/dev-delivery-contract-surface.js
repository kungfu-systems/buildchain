export function devDeliveryWorkflowContractSurface(pkg, majorLine) {
  return {
    id: "dev-pr-auto-merge",
    kind: "workflow",
    path: ".github/workflows/public-ops-dev-auto-merge.yml",
    publicRef: `${pkg.repository ? "kungfu-systems/buildchain" : "buildchain"}/.github/workflows/public-ops-dev-auto-merge.yml@${majorLine}`,
    breakingDefaults: {
      runtimeSelectorDefault: "consumer-contract-lock-or-entry",
      authorityMode: "two-phase-delivery-warrant",
      boundedAuthorityWorkflowIntegration: "not-advertised",
      boundedAuthoritySupportedSurfaces: ["cli", "node-api", "schema"],
      publicFloatingCaller: majorLine,
      durableSelfDeliveryRef: majorLine,
      independentHeartbeatRunner: "macos-15",
      candidateCredentialAccess: "forbidden",
    },
    guarantees: [
      "this reusable workflow executes the single-flight v1 Delivery Warrant and does not advertise bounded v2 Landing integration",
      "bounded v2 authority is a separate opt-in CLI, Node API, and schema surface whose controller deployment must be explicit",
      "candidate execution and evidence sealing receive no provider write credentials",
      "a separate credentialed hosted runner durably heartbeats the exact fence through provider-confirmed native and seal completion",
      "the finalizer validates rooted heartbeat continuity and latest durable state before qualification, failure settlement, or landing",
      "durable consumers call the public floating workflow and may route a train or exact runtime only through trusted non-persistent dispatch input",
    ],
  };
}
