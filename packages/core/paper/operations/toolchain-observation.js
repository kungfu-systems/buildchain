import { commandResult, sha256Text, stableJson } from "../paper-repository.js";
import { SHA256_PATTERN } from "./identity.js";
export function localToolchainObservation(cwd, publication) {
  const toolchain = publication?.toolchain || {};
  const imageRef =
    toolchain.image && toolchain.digest
      ? `${toolchain.image}@${toolchain.digest}`
      : "";
  const dockerVersion = commandResult(
    "docker",
    ["version", "--format", "{{.Client.Version}}"],
    {
      cwd,
      timeout: 5000,
    },
  );
  const image = imageRef
    ? commandResult(
        "docker",
        ["image", "inspect", imageRef, "--format", "{{index .RepoDigests 0}}"],
        {
          cwd,
          timeout: 5000,
        },
      )
    : { ok: false };
  return {
    type: toolchain.type || "",
    image: toolchain.image || "",
    digest: toolchain.digest || "",
    command: toolchain.command || "",
    identityRoot: sha256Text(
      stableJson({
        type: toolchain.type || "",
        image: toolchain.image || "",
        digest: toolchain.digest || "",
        command: toolchain.command || "",
      }),
    ),
    machineVerifiable: Boolean(
      toolchain.type === "latex-docker" &&
      toolchain.image &&
      SHA256_PATTERN.test(toolchain.digest || "") &&
      toolchain.command,
    ),
    dockerAvailable: dockerVersion.ok,
    imageAvailableLocally: image.ok,
  };
}
