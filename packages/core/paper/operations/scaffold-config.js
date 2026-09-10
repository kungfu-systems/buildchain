import { appendNextDevelopmentToml } from "../../release/next-development-projection.js";
import {
  DEFAULT_TOOLCHAIN_IMAGE,
  DEFAULT_TOOLCHAIN_DIGEST,
  DEFAULT_TOOLCHAIN_COMMAND,
} from "./identity.js";
export function tomlString(value) {
  return JSON.stringify(String(value || ""));
}
export function joinUrl(base, suffix = "") {
  const normalizedBase = String(base || "")
    .trim()
    .replace(/\/+$/, "");
  const normalizedSuffix = String(suffix || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!normalizedBase) return "";
  return normalizedSuffix
    ? `${normalizedBase}/${normalizedSuffix}/`
    : `${normalizedBase}/`;
}
export function scaffoldConfig({
  name,
  title,
  packageName,
  version,
  siteBaseUrl,
}) {
  const archiveId = name.replace(/^paper-/, "");
  const canonicalUrl = joinUrl(siteBaseUrl, archiveId);
  const archive = canonicalUrl
    ? `
[publication.archive]
id = ${tomlString(archiveId)}
canonical_url = ${tomlString(canonicalUrl)}
latest_url = ${tomlString(joinUrl(canonicalUrl, "latest"))}
latest_evidence_url = ${tomlString(`${joinUrl(canonicalUrl, "latest")}buildchain.release.json`)}
immutable_base_url = ${tomlString(joinUrl(siteBaseUrl, "archive").replace(/\/$/, ""))}
registry_path = ".buildchain/publication/publication-registry.json"
`
    : "";
  return appendNextDevelopmentToml(`schema = 1

[project]
type = "publication-artifact"
name = ${tomlString(name)}

[publication]
kind = "paper"
title = ${tomlString(title)}
version = ${tomlString(version)}
primary_artifact = "_build/main.pdf"
artifact_paths = ["_build/main.pdf"]
metadata_paths = ["README.md", "docs/MAP.md"]
source_paths = ["paper", "README.md", "LICENSE", "Makefile"]
site_consumers = ${siteBaseUrl ? `[${tomlString(siteBaseUrl)}]` : "[]"}
manifest_path = ".buildchain/publication/publication-artifact.json"
source_bundle_path = ".buildchain/publication/source.tar.gz"
${archive}
[publication.toolchain]
type = "latex-docker"
image = "${DEFAULT_TOOLCHAIN_IMAGE}"
digest = "${DEFAULT_TOOLCHAIN_DIGEST}"
command = "${DEFAULT_TOOLCHAIN_COMMAND}"

[publish]
kind = "npm-paper-package"
package = ${tomlString(packageName)}
auth = "trusted-publishing"

[lifecycle.build]
command = "make pdf"

[lifecycle.verify]
command = "make check"
`);
}
