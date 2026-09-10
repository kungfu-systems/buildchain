import { resolvePublishChannelTargetRef } from "./coordinates.js";
import {
  verifyPublishChannelPrLineage,
  verifyPublishChannelRef,
} from "./lineage.js";
export async function verifyPublishChannelSource(
  {
    sourceRef,
    sourceSha,
    targetRef: requestedTarget,
    repository,
    targetSha: observedTarget,
    pullRequests: observedPulls,
  },
  { resolveRefSha, listPullRequests },
) {
  const targetRef = resolvePublishChannelTargetRef({
    sourceRef,
    targetRef: requestedTarget,
  });
  if (!targetRef)
    return verifyPublishChannelRef({ sourceRef, sourceSha, targetRef });
  const targetSha =
    observedTarget ||
    (await resolveRefSha({ repository, sourceRef: targetRef }));
  const result = verifyPublishChannelRef({
    sourceRef,
    sourceSha,
    targetRef,
    targetSha,
  });
  if (result.skipped) return result;
  const pullRequests =
    observedPulls || (await listPullRequests({ repository, sha: sourceSha }));
  return {
    ...result,
    prLineage: verifyPublishChannelPrLineage({
      sourceRef,
      sourceSha,
      targetRef,
      repository,
      pullRequests,
    }),
  };
}
