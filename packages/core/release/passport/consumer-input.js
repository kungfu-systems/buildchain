import { parseJsonInputWithMeta } from "./inputs.js";
import { releaseField } from "./identity.js";
export function parseConsumerPolicyCertification(input, cwd) {
  return parseJsonInputWithMeta(input, undefined, {
    cwd,
    label: "v4ConsumerPolicyCertificationJson",
  });
}
export function runtimeResumeSourceSha(release, fallback = "") {
  const builtSourceSha = releaseField(
    release || {},
    "builtSourceSha",
    "built_source_sha",
  );
  return release?.treeEquivalent === true && builtSourceSha
    ? builtSourceSha
    : fallback;
}
