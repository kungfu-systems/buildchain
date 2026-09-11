import { getBumpKeyword, normalizeRef, readCurrentVersion } from "./policy.js";
export function verifyReleaseLineage({ workspace, headRef, baseRef }) {
  if (!headRef || !baseRef)
    throw new Error("Release lineage requires both head and base refs");
  const keyword = getBumpKeyword({ cwd: workspace, headRef, baseRef });
  const version = readCurrentVersion(workspace);
  return {
    keyword,
    version: version.version,
    "head-ref": normalizeRef(headRef),
    "base-ref": normalizeRef(baseRef),
  };
}
