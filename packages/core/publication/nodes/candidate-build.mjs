import fs from "node:fs";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
import { verifyPublicationReproducibility } from "../publication-reproducibility.js";

export function publicationControllerIdentities(env, execute = command) {
  const runtime = path.join(env.GITHUB_WORKSPACE, ".buildchain/runtime");
  const sourceSha = execute("git", ["rev-parse", "HEAD"], {
    stdio: "pipe",
  }).trim();
  const runtimeSha = execute("git", ["-C", runtime, "rev-parse", "HEAD"], {
    stdio: "pipe",
  }).trim();
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(runtime, "dist/site/buildchain-contract.json"),
      "utf8",
    ),
  );
  writeGitHubOutputs({
    "source-sha": sourceSha,
    "runtime-sha": runtimeSha,
    "contract-digest": contract.contractDigest,
  });
}
export function provePublicationReproducibility(
  env,
  verify = verifyPublicationReproducibility,
) {
  const qualifying = env.INPUT_PREPARE_PAPER_PACKAGE === "true";
  const result = verify({
    cwd: process.cwd(),
    sourceSha: env.GITHUB_SHA,
    output: ".buildchain/publication/reproducibility-receipt.json",
    promote: true,
    packageName: env.INPUT_PACKAGE_NAME || "",
    allowUnpinnedToolchain: !qualifying,
  });
  fs.mkdirSync(".buildchain", { recursive: true });
  fs.writeFileSync(
    ".buildchain/publication-reproducibility-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  requireValue(
    result.status === "passed" && (!qualifying || result.qualifying === true),
    "Publication reproducibility did not produce qualifying evidence",
  );
  return result;
}
export function namePublicationArtifact(env) {
  const input = JSON.parse(env.BUILDCHAIN_PUBLICATION_REQUEST_JSON);
  writeGitHubOutputs({
    "artifact-name": `${input["artifact-name"]}-${env.GITHUB_SHA}`,
  });
}
