import { createHash } from "node:crypto";
import { stablePipelineDevelopmentReadback } from "./development-transition.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import {
  nextDevelopmentRoot,
  recordNextDevelopmentMaterialization,
  advanceNextDevelopmentTransition,
} from "../../release/next-development-transition.js";

export function developmentTransitionReadback(
  transition,
  { before, after, evidence, createdAt, mergedAt },
) {
  const hash = (bytes) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const paths = [
    ...transition.adapter.sourcePaths,
    ...transition.adapter.derivedPaths,
  ]
    .sort()
    .map((file) => {
      if (
        typeof before.files[file] !== "string" ||
        typeof after.files[file] !== "string"
      )
        throw new Error("Next-development lacks exact declared file bytes");
      return {
        path: file,
        beforeRoot: hash(before.files[file]),
        afterRoot: hash(after.files[file]),
        changed: before.files[file] !== after.files[file],
      };
    });
  if (after.version !== transition.target.version)
    throw new Error(
      "Next-development materialization does not match its authorized target",
    );
  const body = {
    targetVersion: transition.target.version,
    anchorRoot: transition.target.anchor?.manifestRoot || null,
    paths,
  };
  if (!transition.completedAlpha)
    return stablePipelineDevelopmentReadback(
      transition,
      body,
      evidence,
      createdAt,
      mergedAt,
    );
  let state = recordNextDevelopmentMaterialization(transition, {
    materialization: {
      ...body,
      materializationRoot: nextDevelopmentRoot(body),
    },
    evidenceRoot: recordDigest(evidence),
    recordedAt: new Date(createdAt).toISOString(),
  });
  state = advanceNextDevelopmentTransition(state, {
    to: "pr-pending",
    event: "protected-version-pr-observed",
    evidenceRoot: recordDigest(evidence),
    expectedStateRoot: state.state.stateRoot,
    recordedAt: new Date(createdAt).toISOString(),
  });
  if (mergedAt)
    for (const phase of ["merged", "verified"])
      state = advanceNextDevelopmentTransition(state, {
        to: phase,
        event: `protected-version-${phase}`,
        evidenceRoot: recordDigest(evidence),
        expectedStateRoot: state.state.stateRoot,
        recordedAt: new Date(mergedAt).toISOString(),
      });
  return state;
}
