import { loadBuildchainConfig } from "../../consumer/buildchain-config.js";

export async function resolvePublicationToolchain({
  cwd,
  toolchainType = "config",
  toolchainImage = "",
  toolchainDigest = "",
  toolchainCommand = "",
  buildCommand = "",
}) {
  const defaultLatexDockerCommand =
    "latexmk -pdf -outdir=_build paper/main.tex";

  const resolved = selectPublicationToolchain({
    cwd,
    toolchainType,
    toolchainImage,
    toolchainDigest,
    toolchainCommand,
  });
  if (resolved.type === "custom-command" && !resolved.command) {
    resolved.command = buildCommand || "";
  }
  if (!["custom-command", "latex-docker"].includes(resolved.type)) {
    throw new Error(`unsupported publication toolchain: ${resolved.type}`);
  }
  if (resolved.type === "latex-docker") {
    if (!resolved.command) {
      resolved.command = defaultLatexDockerCommand;
    }
    if (!resolved.image)
      throw new Error(
        "latex-docker publication toolchain requires toolchain-image or publication.toolchain.image",
      );
    if (!/^sha256:[0-9a-f]{64}$/i.test(resolved.digest || "")) {
      throw new Error(
        "latex-docker publication toolchain requires toolchain-digest or publication.toolchain.digest as sha256:<64 hex>",
      );
    }
    if (!resolved.command)
      throw new Error(
        "latex-docker publication toolchain requires toolchain-command or publication.toolchain.command",
      );
  }
  return {
    ...resolved,
    imageRef:
      resolved.image && resolved.digest
        ? `${resolved.image}@${resolved.digest}`
        : "",
  };
}

function selectPublicationToolchain({
  cwd,
  toolchainType,
  toolchainImage,
  toolchainDigest,
  toolchainCommand,
}) {
  const inputType = (toolchainType || "config").trim();
  const inputToolchain = {
    type: inputType,
    image: toolchainImage || "",
    digest: toolchainDigest || "",
    command: toolchainCommand || "",
  };
  const configToolchain =
    loadBuildchainConfig(cwd)?.config?.publication?.toolchain || {};
  const resolved =
    inputType && inputType !== "config"
      ? inputToolchain
      : {
          type: configToolchain.type || "custom-command",
          image: configToolchain.image || "",
          digest: configToolchain.digest || "",
          command: configToolchain.command || "",
        };
  return resolved;
}
