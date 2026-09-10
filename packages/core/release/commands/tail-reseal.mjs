#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { getOctokit } from "@actions/github";
import { normalizeTailResealRequest, planTailReseal } from "../tail-reseal.js";
import { createTailResealReceipt } from "../tail-reseal-receipt.js";
import { verifyTailResealPlatform } from "../reseal/platform.js";
import { admitTailResealFromGitHub } from "../reseal/admission.js";
import { collectReadbacks } from "../reseal/readbacks.js";
import { required, readJson, writeJson } from "../reseal/files.js";
function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : String(args[index + 1] || "");
}

function appendOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("\n")}\n`,
  );
}

export function runTailResealCli(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  const requestPath = flag(options, "request");
  if (command === "plan") {
    const request = normalizeTailResealRequest(
      readJson(required(requestPath, "--request"), "tail reseal request"),
    );
    const plan = planTailReseal(request);
    const output = writeJson(
      flag(options, "output", ".buildchain/tail-reseal/plan.json"),
      plan,
    );
    appendOutputs({
      "plan-root": plan.planRoot,
      "plan-path": path.relative(process.cwd(), output),
      "source-run-id": request.source.runId,
      "source-run-attempt": request.source.runAttempt,
      "source-sha": request.source.sha,
      "source-tree-sha": request.source.treeSha,
      "runtime-sha": request.runtime.sha,
      "consumer-policy-receipt-root": request.runtime.consumerPolicyReceiptRoot,
      "warrant-readback-root": request.warrant.stateReadbackRoot,
      "signing-provider-readback-root": request.signing.providerReadbackRoot,
      "release-tail-provider-readback-root":
        request.releaseTail.providerReadbackRoot,
      "signing-authority-repository": request.signing.authorityRepository,
      "signing-authority-run-id": request.signing.authorityRunId,
      "signing-result-artifact": request.signing.resultArtifact,
      "target-version": request.target.version,
      "platforms-json": JSON.stringify(request.platforms),
    });
    return plan;
  }
  if (command === "admit") {
    const request = normalizeTailResealRequest(
      readJson(required(requestPath, "--request"), "tail reseal request"),
    );
    return admitTailResealFromGitHub(
      request,
      getOctokit(required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN")),
    ).then((admission) => {
      const output = writeJson(
        flag(options, "output", ".buildchain/tail-reseal/admission.json"),
        admission,
      );
      appendOutputs({
        "admission-root": admission.admissionRoot,
        "admission-path": path.relative(process.cwd(), output),
      });
      return admission;
    });
  }
  if (command === "verify-platform") {
    const readback = verifyTailResealPlatform({
      request: readJson(required(requestPath, "--request")),
      platformId: required(flag(options, "platform"), "--platform"),
      artifactRoot: flag(options, "artifact-root", process.cwd()),
      mode: flag(options, "mode", "retained"),
      providerReadbackRoot: flag(options, "provider-readback-root") || null,
    });
    const output = writeJson(
      flag(
        options,
        "output",
        `.buildchain/tail-reseal/${readback.platformId}-readback.json`,
      ),
      readback,
    );
    appendOutputs({
      "readback-path": path.relative(process.cwd(), output),
      "artifact-root": readback.artifactRoot,
      "manifest-root": readback.manifestRoot,
    });
    return readback;
  }
  if (command === "seal") {
    const request = readJson(required(requestPath, "--request"));
    const receipt = createTailResealReceipt({
      request,
      plan: readJson(required(flag(options, "plan"), "--plan")),
      readbacks: collectReadbacks(
        required(flag(options, "readbacks"), "--readbacks"),
      ),
      passport: readJson(required(flag(options, "passport"), "--passport")),
      protectedReadbackRoot: required(
        flag(options, "protected-readback-root"),
        "--protected-readback-root",
      ),
      currentRun: {
        id: Number(required(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID")),
        attempt: Number(
          required(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
        ),
      },
    });
    const output = writeJson(
      flag(options, "output", ".buildchain/tail-reseal/receipt.json"),
      receipt,
    );
    appendOutputs({
      "receipt-root": receipt.receiptRoot,
      "receipt-path": path.relative(process.cwd(), output),
    });
    return receipt;
  }
  throw new Error(
    "usage: buildchain tail-reseal <plan|admit|verify-platform|seal> --request <request.json> [options]",
  );
}

if (
  !process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  Promise.resolve()
    .then(() => runTailResealCli())
    .catch((error) => {
      console.error(`tail-reseal: ${error.message}`);
      process.exitCode = 1;
    });
}
