const NON_AUTHORITIES = [
  "first-party-identity", "system-identity", "kfd-compliance", "product-system-metadata",
  "package-metadata", "registry-history", "scan-output", "standalone-generation",
];
const RENDITIONS = [
  { id: "1080p", role: "primary", columns: 150, rows: 36, width: 1920, height: 1080 },
  { id: "720p", role: "responsive", columns: 100, rows: 28, width: 1280, height: 720 },
];

export function scenario() {
  const step = (id, argv, stdoutIncludes, fileAssertions = []) => ({
    id, argv, timeoutSeconds: 20, expectedExitCodes: [0], stdoutIncludes, fileAssertions,
  });
  return {
    schema: "buildchain.declarative-binary-demo/v1",
    compositionMode: "terminal-fill",
    product: { id: "fixture", displayName: "Fixture CLI", binaryName: "fixture" },
    artifact: { platformId: "linux-x64", binaryPath: "fixture", metadataPath: "fixture.json", metadataContract: "fixture.binary/v1", runtimeDependencies: [] },
    execution: { deterministic: true, network: "none", secrets: "none", totalTimeoutSeconds: 30, environment: {} },
    transportSmoke: { argv: ["independent"], timeoutSeconds: 20, expectedExitCodes: [0], stdoutIncludes: ["INDEPENDENT END"] },
    renditions: RENDITIONS,
    demos: [
      {
        id: "shared-state", title: "Shared state", claimBoundary: "The fixture proves only declared local state sharing.",
        steps: [
          step("write", ["write"], ["STATE WRITTEN"]),
          step("read", ["read"], ["STATE READ"], [{ path: "state.json", jsonEquals: { status: "ready" } }]),
        ],
      },
      {
        id: "independent", title: "Independent demo", claimBoundary: "The fixture proves only independent demo workspaces.",
        steps: [step("independent", ["independent"], ["INDEPENDENT"])],
      },
    ],
    publication: { evidencePath: "docs/evidence/auditable-demo", readmePath: "README.md", marker: "fixture-demo" },
    authority: { grants: [], nonAuthorities: NON_AUTHORITIES },
  };
}

export function declareLongForm(value) {
  value.execution.durationClass = "long-form";
  value.execution.totalTimeoutSeconds = 180;
  for (const demo of value.demos) {
    for (const step of demo.steps) step.timeoutSeconds = 180;
  }
}

export function declarePresentation(value) {
  declareLongForm(value);
  value.presentation = {
    schema: "buildchain.declarative-demo-presentation/v1",
    proofs: value.demos.map((demo, index) => ({
      demoId: demo.id,
      label: index === 0 ? "Continuity" : "Failure retention",
      question: demo.title,
      summary: index === 0
        ? "The first proof isolates continuity across sessions."
        : "The second proof places continuity under failure.",
      ...(index === 0 ? { transitionAfter: "Continuity must also survive failure." } : {}),
    })),
    materialization: {
      readmeMode: "media-only",
      technicalSpecPath: "docs/demo-technical-spec.md",
      technicalSpecTitle: "Fixture demo technical specification",
      technicalMarker: "fixture-demo:technical",
    },
  };
}
