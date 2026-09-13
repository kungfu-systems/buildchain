import {
  createNextDevelopmentTransition,
  bindNextDevelopmentAnchor,
  nextDevelopmentRoot,
} from "../../release/next-development-transition.js";
import { createStableDevelopmentTransition } from "../publication-development.js";
import { recordDigest } from "../../release/discussion/envelope.js";

export function createPipelineDevelopmentTransition(context, publication) {
  const { plan, materialization } = context;
  const input = {
    repository: plan.source.repository,
    model: {
      strategy: plan.versionPolicy.strategy,
      next: plan.versionPolicy.strategy === "semver" ? "auto" : "manual",
    },
    sourcePaths: [
      ...new Set(plan.versionPolicy.files.map(({ path }) => path)),
    ].sort(),
    derivedPaths: [...(plan.versionPolicy.derived_files || [])].sort(),
  };
  const completed = {
    outcome: "succeeded",
    version: plan.version,
    exactTag: plan.tag,
    releaseSha: materialization.source.commit,
    treeSha: materialization.source.tree,
    publicationRoot: publication.release.receiptRoot,
    completedAt: publication.completedAt,
  };
  if (plan.channel === "alpha")
    return createNextDevelopmentTransition({
      ...input,
      completedAlpha: completed,
    });
  const adapter = {
    sourcePaths: input.sourcePaths,
    derivedPaths: input.derivedPaths,
  };
  if (input.model.strategy === "semver")
    return {
      ...createStableDevelopmentTransition({
        ...input,
        completedStable: completed,
      }),
      adapter,
    };
  const identity = {
    contract: "buildchain.pipeline-stable-anchor-transition/v1",
    ...input,
    completedStable: completed,
  };
  return {
    ...identity,
    idempotencyKey: nextDevelopmentRoot(identity),
    adapter,
    target: { version: null, anchor: null },
    state: { status: "waiting-anchor" },
    publicationOutcome: "preserved-success",
  };
}

export function bindPipelineDevelopmentAnchor(transition, input) {
  if (transition.completedAlpha)
    return bindNextDevelopmentAnchor(transition, input);
  if (
    transition.contract !== "buildchain.pipeline-stable-anchor-transition/v1" ||
    transition.state.status !== "waiting-anchor" ||
    !input.targetVersion ||
    !input.anchor?.manifestRoot
  )
    throw new Error(
      "Stable manual development requires its explicit protected anchor",
    );
  return {
    ...transition,
    target: { version: input.targetVersion, anchor: input.anchor },
  };
}

export function stablePipelineDevelopmentReadback(
  transition,
  materialization,
  evidence,
  createdAt,
  mergedAt,
) {
  if (
    ![
      "buildchain.stable-development-transition/v1",
      "buildchain.pipeline-stable-anchor-transition/v1",
    ].includes(transition.contract)
  )
    throw new Error("Unknown stable development transition");
  const state = {
    status: mergedAt ? "verified" : "pr-pending",
    evidenceRoot: recordDigest(evidence),
    recordedAt: new Date(mergedAt || createdAt).toISOString(),
    materializationRoot: nextDevelopmentRoot(materialization),
  };
  return {
    ...transition,
    materialization,
    state: {
      ...state,
      stateRoot: nextDevelopmentRoot({
        transitionRoot: transition.idempotencyKey,
        ...state,
      }),
    },
  };
}
