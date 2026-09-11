import path from "node:path";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
import { normalizeTailResealRequest } from "../tail-reseal.js";
import { verifyTailResealPlatform } from "./platform.js";
import { verifyResealProviderReadbacks } from "./readbacks.js";
import { readJson, writeJson } from "./files.js";
export async function finalizeResealPlatform({
  workspace,
  runtimeSha,
  platformId,
  finalizationCommand,
  signingToken,
  environment,
  hostPlatform = process.platform,
}) {
  const directory = path.join(workspace, ".buildchain/tail-reseal");
  const request = normalizeTailResealRequest(
    readJson(path.join(directory, "request.json")),
  );
  let readback = verifyTailResealPlatform({
    request,
    platformId,
    artifactRoot: workspace,
    mode: "retained",
  });
  const output = path.join(directory, `${platformId}-readback.json`);
  writeJson(output, readback);
  if (platformId === "macos-arm64") {
    if (hostPlatform !== "darwin")
      throw new Error("macOS finalization requires the declared macOS runner");
    await consumerCommandSession(environment).run({
      script: finalizationCommand,
      cwd: workspace,
      strict: true,
      env: {
        BUILDCHAIN_SIGNING_TOKEN: signingToken,
        BUILDCHAIN_TAIL_RESEAL_COMMAND: finalizationCommand,
        BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH: path.join(
          directory,
          "request.json",
        ),
        BUILDCHAIN_TAIL_RESEAL_SIGNING_RESULT_ROOT: path.join(
          directory,
          "signing-result",
        ),
      },
    });
    verifyResealProviderReadbacks({
      directory,
      signingRoot: request.signing.providerReadbackRoot,
      releaseTailRoot: request.releaseTail.providerReadbackRoot,
    });
    readback = verifyTailResealPlatform({
      request,
      platformId,
      artifactRoot: workspace,
      mode: "resealed",
      providerReadbackRoot: request.signing.providerReadbackRoot,
    });
    writeJson(output, readback);
  }
  return readback;
}
