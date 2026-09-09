import crypto from "node:crypto";
import { RELEASE_PROPAGATION_WORK_STAGES } from "../../packages/core/release/release-propagation.js";

export function shaRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export function workRef(kind, subject) {
  return {
    schema: "kungfu.assignment-graph.work-ref/v1",
    workspace_identity_root: shaRoot(`${subject}:workspace`),
    object_kind: kind,
    subject,
    version_root: shaRoot(`${subject}:version`),
    cut_root: shaRoot(`${subject}:cut`),
  };
}

export function typedReference(kind, identity, status, familyState) {
  return {
    kind,
    identity,
    root: shaRoot(`${kind}:${identity}`),
    factWorld: familyState.factWorld,
    cutRoot: familyState.cutRoot,
    schema: `kungfu.test.${kind}/v1`,
    status,
  };
}

export function propagationWorkContext(mode = "execute") {
  const familyState = {
    schema: "kungfu.work-control.initiative-family-state/v2",
    stateRoot: shaRoot("family-state"),
    v1ProjectionRoot: shaRoot("family-v1"),
    typedBindingRoot: shaRoot("family-bindings"),
    factWorld: "kungfu-test-world",
    cutRoot: shaRoot("family-cut"),
  };
  return {
    parentWorkRef: workRef("initiative", "paper-publication"),
    childWorkRef: workRef("assignment", "site-propagation"),
    familyState,
    authority:
      mode === "execute"
        ? {
            mode: "execute",
            publishToProduction: true,
            allowedActions: [...RELEASE_PROPAGATION_WORK_STAGES].sort(),
            executionPrincipal: "codex/pro-1802",
            sourceControlPrincipal: "dongkeren",
            executionWarrant: typedReference(
              "execution-warrant",
              "warrant-1",
              "active",
              familyState,
            ),
          }
        : {
            mode: "capture-only",
            publishToProduction: false,
            allowedActions: [],
            executionPrincipal: null,
            sourceControlPrincipal: null,
            executionWarrant: null,
          },
    supersedesWorkRoot: "",
  };
}
