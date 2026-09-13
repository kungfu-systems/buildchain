import { recordDigest } from "../../release/discussion/envelope.js";
import { collectPipelineVersionMaterial } from "./version-regeneration.js";
import { materializePipelineVersion } from "./version.js";

// Provider execution is qualified and journaled by version-context before this
// pure byte check. A self-reported digest never grants Git write authority.
export function preparedPipelineVersionMaterial(plan, files, regeneration) {
  if (!regeneration) {
    if (plan.versionPolicy.derived_files?.length)
      throw new Error(
        "Derived version files require retained qualified regeneration",
      );
    return materializePipelineVersion(plan.versionPolicy, files, plan.version);
  }
  const { context, build, results } = regeneration;
  const { preparation } = context;
  const { root: buildRoot, ...buildBody } = build;
  if (
    preparation.parentRoot !== plan.root ||
    preparation.version !== plan.version ||
    recordDigest(preparation.source) !== recordDigest(plan.source) ||
    recordDigest(preparation.versionPolicy) !==
      recordDigest(plan.versionPolicy) ||
    build.preparationRoot !== preparation.root ||
    build.runId !== context.runId ||
    build.runAttempt !== context.runAttempt ||
    buildRoot !== recordDigest(buildBody)
  )
    throw new Error(
      "Qualified regeneration does not belong to this exact version materialization",
    );
  return {
    ...collectPipelineVersionMaterial(preparation, files, results),
    regenerationBuildRoot: buildRoot,
  };
}
