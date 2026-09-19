import { githubPipelineNativeResults } from "../../providers/github/pipeline-native-results.js";
import { reobservePublicationBuild } from "./recovery-build-readback.js";
import { verifyRetainedNativeQualification } from "./native-qualification.js";

// Already qualified bytes come from durable publication retention. Re-observe
// the immutable producer jobs; expiring the temporary signing transport does
// not authorize rebuilding or replacing those signed bytes.
export async function reobservePipelineNativeQualification(
  qualified,
  plan,
  host,
  signingHost,
) {
  verifyRetainedNativeQualification(qualified, plan);
  if (!qualified.native) return [];
  if (!signingHost)
    throw new Error(
      "Native recovery requires independent authority readback access",
    );
  const authority = githubPipelineNativeResults(signingHost);
  const jobs = [];
  const finalizers = new Set();
  for (const proof of qualified.native.platforms) {
    await authority.reobserve(proof.lineage.operation, proof.lineage.authority);
    if (!finalizers.has(proof.finalizer.root)) {
      await reobservePublicationBuild(proof.finalizer, qualified.source, host);
      finalizers.add(proof.finalizer.root);
      jobs.push(...proof.finalizer.jobs);
    }
    jobs.push(...proof.lineage.authority.jobs);
  }
  return jobs;
}
