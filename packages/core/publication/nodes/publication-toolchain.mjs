import fs from "node:fs";
import { loadBuildchainConfig } from "../../consumer/buildchain-config.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";

export async function resolvePublicationToolchain(env) {
  const defaultLatexDockerCommand =
    "latexmk -pdf -outdir=_build paper/main.tex";

  const resolved = selectPublicationToolchain(env);
  if (resolved.type === "custom-command" && !resolved.command) {
    resolved.command = env.INPUT_BUILD_COMMAND || "";
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
  writeGitHubOutputs({
    type: resolved.type,
    image: resolved.image || "",
    digest: resolved.digest || "",
    command: resolved.command || "",
    "image-ref":
      resolved.image && resolved.digest
        ? `${resolved.image}@${resolved.digest}`
        : "",
  });
  fs.appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    [
      "## Publication toolchain",
      "",
      `- type: \`${resolved.type}\``,
      `- image: \`${resolved.image || "(none)"}\``,
      `- digest: \`${resolved.digest || "(none)"}\``,
      "",
    ].join("\n"),
  );
}

function selectPublicationToolchain(env) {
  const cwd = process.cwd();
  const inputType = (env.INPUT_TOOLCHAIN_TYPE || "config").trim();
  const inputToolchain = {
    type: inputType,
    image: env.INPUT_TOOLCHAIN_IMAGE || "",
    digest: env.INPUT_TOOLCHAIN_DIGEST || "",
    command: env.INPUT_TOOLCHAIN_COMMAND || "",
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
