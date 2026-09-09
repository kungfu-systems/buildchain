export function repositoryCoordinates(input, caller) {
  const repository = input || caller || "";
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(repository);
  if (!match) throw new Error("repository must be owner/repo");
  return { repository, owner: match[1], name: match[2] };
}

export function stableReleaseCoordinates(input, callerRef) {
  let target = input || "";
  if (!target) {
    if (!/^dev\/v\d+\/v\d+\.\d+$/u.test(callerRef || "")) throw new Error("target-branch is required when the caller ref is not dev/vN/vN.M");
    target = `release/${callerRef.slice(4)}`;
  }
  if (!/^release\/v\d+\/v\d+\.\d+$/u.test(target)) throw new Error("target-branch must be release/vN/vN.M");
  return { "target-branch": target, "artifact-line": target.replaceAll("/", "-") };
}
