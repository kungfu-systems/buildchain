import { assertExactFields } from "./release-propagation-common.js";
import {
  contentRoot,
  normalizeWorkRef,
} from "./release-propagation-work-control.js";

function automaticWorkRef({ repository, subject, version, cut }) {
  return normalizeWorkRef({
    schema: "kungfu.assignment-graph.work-ref/v1",
    workspace_identity_root: contentRoot({
      authority: "kungfu-buildchain-release-propagation",
      repository,
    }),
    object_kind: "assignment",
    subject,
    version_root: contentRoot(version),
    cut_root: contentRoot(cut),
  }, `automatic WorkRef ${subject}`);
}

function automaticCaptureContext(selectedPlan, selected, propagationKey) {
  const release = selectedPlan.upstreamRelease;
  const version = release.package?.version || release.publicationArtifact?.version;
  return {
    parentWorkRef: automaticWorkRef({
      repository: release.repository,
      subject: `buildchain:release:${release.repository}/${version}`,
      version: release,
      cut: { repository: release.repository, sourceSha: release.sourceSha },
    }),
    childWorkRef: automaticWorkRef({
      repository: selected.repository,
      subject: `buildchain:propagation:${selected.repository}/${propagationKey}`,
      version: selected.lock,
      cut: { propagationKey, expectedTarget: selected.target },
    }),
    familyState: null,
    authority: {
      mode: "capture-only",
      publishToProduction: false,
      allowedActions: [],
      executionPrincipal: null,
      sourceControlPrincipal: null,
      executionWarrant: null,
    },
    supersedesWorkRoot: "",
    bindingState: "pending",
  };
}

export function resolveWorkContext(workContext, selectedPlan, selected, propagationKey) {
  if (workContext === undefined || workContext === null) {
    return automaticCaptureContext(selectedPlan, selected, propagationKey);
  }
  const context = assertExactFields(workContext, [
    "parentWorkRef",
    "childWorkRef",
    "familyState",
    "authority",
    "supersedesWorkRoot",
  ], "workContext");
  return { ...context, bindingState: "bound" };
}

