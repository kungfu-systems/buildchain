import { createRegistryClient } from "../../release/promote-candidate/oci-registry-client.js";
import { check, digest } from "./preview-values.js";
export function createComposePreviewRegistry(
  { token, actor },
  fetchImpl = fetch,
) {
  check(
    typeof token === "string" &&
      token.length > 0 &&
      typeof actor === "string" &&
      actor.length > 0,
    "explicit scoped registry identity required",
  );
  return createRegistryClient(token, fetchImpl, actor);
}

export function previewManifestReader(application, registry) {
  return async function fetchManifest(ref, allowAbsent = false) {
    const response = await registry(application, `manifests/${ref}`, {
      headers: {
        accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json",
      },
    });
    if (allowAbsent && response.status === 404) return { digest: "none" };
    check(response.ok, "public registry readback unavailable");
    const bytes = Buffer.from(await response.arrayBuffer()),
      value = digest(bytes);
    check(
      !response.headers.get("docker-content-digest") ||
        response.headers.get("docker-content-digest") === value,
      "registry digest mismatch",
    );
    return { bytes, digest: value, mediaType: JSON.parse(bytes).mediaType };
  };
}
