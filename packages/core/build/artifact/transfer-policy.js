export function resolveArtifactTransfer({
  mode = "github-artifacts",
  relayRequired = true,
  bucket,
  region,
  prefix = "buildchain-artifacts",
  uploadRole,
  downloadRole,
  oidcAudience,
}) {
  if (!["github-artifacts", "s3-to-github-artifacts"].includes(mode))
    throw new Error(`Invalid artifact transfer mode: ${mode}`);
  if (mode === "github-artifacts" || !relayRequired)
    return {
      mode: "github-artifacts",
      s3Bucket: "",
      s3Region: "",
      s3Prefix: "",
      oidcAudience: "",
    };
  if (!bucket) throw new Error("S3 relay requires artifact-relay-s3-bucket");
  if (!region) throw new Error("S3 relay requires artifact-relay-s3-region");
  if (!uploadRole) throw new Error("S3 relay requires an upload role ARN");
  if (!downloadRole) throw new Error("S3 relay requires a download role ARN");
  return {
    mode,
    s3Bucket: bucket,
    s3Region: region,
    s3Prefix: prefix || "buildchain-artifacts",
    oidcAudience:
      oidcAudience ||
      (region.startsWith("cn-") ? "sts.amazonaws.com.cn" : "sts.amazonaws.com"),
  };
}
