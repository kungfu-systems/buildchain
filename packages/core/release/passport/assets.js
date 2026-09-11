import { nonEmptyString, optionalString } from "./identity.js";
export function inferPlatformFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (
    lower.includes("apple-darwin") ||
    lower.includes("darwin") ||
    lower.includes("macos")
  ) {
    return lower.includes("aarch64") || lower.includes("arm64")
      ? "darwin-arm64"
      : "darwin-x64";
  }
  if (
    lower.includes("windows") ||
    lower.includes("pc-windows") ||
    lower.endsWith(".zip")
  ) {
    return "windows-x64";
  }
  if (lower.includes("linux") || lower.includes("unknown-linux")) {
    return lower.includes("aarch64") || lower.includes("arm64")
      ? "linux-arm64"
      : "linux-x64";
  }
  return "";
}
export function normalizeAsset(asset, index = 0) {
  const name = nonEmptyString(
    asset.name || asset.filename,
    `assets[${index}].name`,
  );
  const digest = optionalString(asset.digest || asset.sha256 || asset.checksum);
  const sha256 = digest.replace(/^sha256:/, "");
  return {
    name,
    kind: optionalString(asset.kind || "release-asset"),
    platform: optionalString(asset.platform || inferPlatformFromName(name)),
    size: Number(asset.size || asset.sizeBytes || 0),
    url: optionalString(
      asset.browser_download_url || asset.downloadUrl || asset.url,
    ),
    githubAssetId: optionalString(asset.id || asset.githubAssetId),
    sha256,
    sourcePath: optionalString(asset.path || asset.sourcePath),
  };
}
