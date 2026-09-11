import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { rebindPublicationGateAggregateForEquivalentTree } from "../../release/release-candidate-recovery.js";
import { publicationAuthorityDigest } from "../publication-authority.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
import { command } from "../../runtime/action-process.mjs";

export async function assembleConsumerGate(request, execute = command) {
  fs.mkdirSync(path.dirname(request.resultPath), { recursive: true });
  const session = consumerCommandSession(request.environment);
  await session.run(
    {
      cwd: request.controllerRoot || request.subjectRoot,
      script: request.command,
      strict: true,
    },
    execute,
  );
  const resultPath = request.resultPath;
  if (!fs.existsSync(resultPath) || !fs.statSync(resultPath).isFile()) {
    throw new Error(
      "consumer Gate command did not write BUILDCHAIN_PUBLICATION_GATE_RESULT_PATH",
    );
  }
  let aggregate = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const subjectRoot = request.subjectRoot;
  const targetSourceSha = execFileSync(
    "git",
    ["-C", subjectRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (targetSourceSha !== request.targetSourceSha) {
    throw new Error(
      "consumer Gate subject checkout does not match the exact publication source SHA",
    );
  }
  const targetTree = execFileSync(
    "git",
    ["-C", subjectRoot, "rev-parse", "HEAD^{tree}"],
    { encoding: "utf8" },
  ).trim();
  aggregate = rebindPublicationGateAggregateForEquivalentTree(aggregate, {
    evidenceSourceSha: request.evidenceSourceSha,
    targetSourceSha: request.targetSourceSha,
    targetSourceTreeSha: targetTree,
    expectedSourceTreeSha: request.evidenceSourceTree || targetTree,
  });
  const controllerSha = String(request.controllerSha || "").toLowerCase();
  if (controllerSha) {
    if (!/^[0-9a-f]{40}$/.test(controllerSha))
      throw new Error("consumer Gate controller SHA must be exact");
    const actualControllerSha = execFileSync(
      "git",
      ["-C", request.controllerRoot, "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    ).trim();
    if (actualControllerSha !== controllerSha)
      throw new Error(
        "consumer Gate controller checkout does not match its exact SHA",
      );
    const { digest: _digest, ...payload } = aggregate;
    const rebound = {
      ...payload,
      consumerGateController: {
        repository: request.repository,
        sha: controllerSha,
        commandDigest: `sha256:${crypto.createHash("sha256").update(request.command).digest("hex")}`,
      },
    };
    aggregate = {
      ...rebound,
      digest: `sha256:${publicationAuthorityDigest(rebound)}`,
    };
  }
  return aggregate;
}
