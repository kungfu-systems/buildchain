import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { command } from "../../runtime/action-process.mjs";

export async function assembleConsumerGate(env, execute = command) {
  fs.mkdirSync(path.dirname(env.BUILDCHAIN_PUBLICATION_GATE_RESULT_PATH), {
    recursive: true,
  });
  execute("bash", [
    "-euo",
    "pipefail",
    "-c",
    env.BUILDCHAIN_CONSUMER_GATE_COMMAND,
  ]);

  const resultPath = env.BUILDCHAIN_PUBLICATION_GATE_RESULT_PATH;
  if (!fs.existsSync(resultPath) || !fs.statSync(resultPath).isFile()) {
    throw new Error(
      "consumer Gate command did not write BUILDCHAIN_PUBLICATION_GATE_RESULT_PATH",
    );
  }
  let aggregate = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const runtimeRoot = env.BUILDCHAIN_PUBLICATION_AUTHORITY_RUNTIME_ROOT;
  const recovery = await import(
    pathToFileURL(
      path.join(
        runtimeRoot,
        "packages/core/release/release-candidate-recovery.js",
      ),
    ).href
  );
  const authority = await import(
    pathToFileURL(
      path.join(
        runtimeRoot,
        "packages/core/publication/publication-authority.js",
      ),
    ).href
  );
  const subjectRoot = env.BUILDCHAIN_PUBLICATION_SUBJECT_ROOT;
  const targetSourceSha = execFileSync(
    "git",
    ["-C", subjectRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (targetSourceSha !== env.BUILDCHAIN_PUBLICATION_TARGET_SOURCE_SHA) {
    throw new Error(
      "consumer Gate subject checkout does not match the exact publication source SHA",
    );
  }
  const targetTree = execFileSync(
    "git",
    ["-C", subjectRoot, "rev-parse", "HEAD^{tree}"],
    { encoding: "utf8" },
  ).trim();
  aggregate = recovery.rebindPublicationGateAggregateForEquivalentTree(
    aggregate,
    {
      evidenceSourceSha: env.BUILDCHAIN_PUBLICATION_SOURCE_SHA,
      targetSourceSha: env.BUILDCHAIN_PUBLICATION_TARGET_SOURCE_SHA,
      targetSourceTreeSha: targetTree,
      expectedSourceTreeSha:
        env.BUILDCHAIN_PUBLICATION_EVIDENCE_SOURCE_TREE || targetTree,
    },
  );
  const controllerSha = String(
    env.BUILDCHAIN_PUBLICATION_CONSUMER_CONTROLLER_SHA || "",
  ).toLowerCase();
  if (controllerSha) {
    if (!/^[0-9a-f]{40}$/.test(controllerSha))
      throw new Error("consumer Gate controller SHA must be exact");
    const actualControllerSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (actualControllerSha !== controllerSha)
      throw new Error(
        "consumer Gate controller checkout does not match its exact SHA",
      );
    const { digest: _digest, ...payload } = aggregate;
    const rebound = {
      ...payload,
      consumerGateController: {
        repository: env.BUILDCHAIN_PUBLICATION_CONSUMER_CONTROLLER_REPOSITORY,
        sha: controllerSha,
        commandDigest: `sha256:${crypto.createHash("sha256").update(env.BUILDCHAIN_CONSUMER_GATE_COMMAND).digest("hex")}`,
      },
    };
    aggregate = {
      ...rebound,
      digest: `sha256:${authority.publicationAuthorityDigest(rebound)}`,
    };
  }
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `gate-aggregate-json=${JSON.stringify(aggregate)}\n`,
  );
}
