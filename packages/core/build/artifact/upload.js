import fs from "node:fs";
import path from "node:path";
import { uploadRelayArtifacts } from "../../providers/artifact-relay/transactions.js";
import {
  artifactNames,
  executionResult,
  verifyExecution,
  verifyManifest,
} from "./contracts.js";
import { readJson } from "../plan/values.js";
export async function transferBuild(context, platform) {
  const { plan, workspace, sourceRoot, store, relay } = context;
  const { upload, publishRecord } = store;
  const names = artifactNames(plan, platform);
  const executionFile = path.join(
    sourceRoot,
    `.buildchain/execution/${platform.id}.json`,
  );
  const execution = fs.existsSync(executionFile)
    ? readJson(executionFile)
    : executionResult(plan, platform, {});
  const artifacts = [];
  const qualified = ["success", "not-required"].includes(
    execution.stages.verify,
  );
  if (qualified) {
    verifyExecution(execution, plan, platform);
    const paths = [
      ...plan.artifacts.paths.split("\n"),
      `.buildchain/artifacts/${platform.id}`,
      ".buildchain/artifacts/signing",
    ];
    verifyManifest(
      path.join(
        sourceRoot,
        `.buildchain/artifacts/${platform.id}/manifest.json`,
      ),
      sourceRoot,
      plan,
      platform,
    );
    if (
      plan.transfer.mode === "s3-to-github-artifacts" &&
      !platform.githubHosted
    ) {
      const file = `.buildchain/relay/${platform.id}/relay-manifest.json`;
      await uploadRelayArtifacts({
        client: relay,
        workspace: sourceRoot,
        manifestPath: file,
        bucket: plan.transfer.s3Bucket,
        region: plan.transfer.s3Region,
        prefix: plan.transfer.s3Prefix,
        repository: plan.run.repository,
        runId: plan.run.id,
        runAttempt: plan.run.attempt,
        sourceSha: plan.source.sha,
        platformId: platform.id,
        platformName: platform.name,
        groups: [{ role: "payload", artifactName: names.payload, paths }],
      });
      artifacts.push({
        role: "relay",
        ref: await upload(
          plan,
          names.relay,
          ["relay-manifest.json"],
          path.dirname(path.join(sourceRoot, file)),
        ),
      });
    } else
      artifacts.push({
        role: "payload",
        ref: await upload(plan, names.payload, paths, sourceRoot),
      });
    const requestRoot = path.join(
      sourceRoot,
      `.buildchain/signing/requests/${platform.id}`,
    );
    const index = readJson(path.join(requestRoot, "index.json"));
    if (index.requests.length)
      artifacts.push({
        role: "request",
        ref: await upload(plan, names.request, ["."], requestRoot),
      });
    artifacts.push({
      role: "control",
      ref: await upload(
        plan,
        names.control,
        ["request.json"],
        path.join(
          sourceRoot,
          `.buildchain/signing/control-requests/${platform.id}`,
        ),
      ),
    });
    if (
      plan.build.macos_signing.app_path &&
      plan.build.macos_signing.platform === platform.id
    ) {
      const credentialRoot = path.join(
        sourceRoot,
        `.buildchain/credential-island/${platform.id}`,
      );
      if (
        plan.transfer.mode === "s3-to-github-artifacts" &&
        !platform.githubHosted
      ) {
        const file = path.join(
          workspace,
          `.buildchain/credential-relay/${platform.id}/relay-manifest.json`,
        );
        await uploadRelayArtifacts({
          client: relay,
          workspace: credentialRoot,
          manifestPath: file,
          bucket: plan.transfer.s3Bucket,
          region: plan.transfer.s3Region,
          prefix: plan.transfer.s3Prefix,
          repository: plan.run.repository,
          runId: plan.run.id,
          runAttempt: plan.run.attempt,
          sourceSha: plan.source.sha,
          platformId: platform.id,
          platformName: platform.name,
          groups: [
            {
              role: "credential-input",
              artifactName: names.credentialInput,
              paths: ["."],
            },
          ],
        });
        artifacts.push({
          role: "credentialRelay",
          ref: await upload(
            plan,
            names.credentialRelay,
            ["relay-manifest.json"],
            path.dirname(file),
          ),
        });
      } else
        artifacts.push({
          role: "credential",
          ref: await upload(plan, names.credentialInput, ["."], credentialRoot),
        });
    }
  }
  const evidence = await upload(
    plan,
    names.diagnostics,
    [
      `.buildchain/artifacts/${platform.id}`,
      ".buildchain/diagnostics",
      ".buildchain/logs",
      ...(plan.build.verification.substage_evidence_path
        ? [
            path.posix.join(
              plan.project.cwd,
              plan.build.verification.substage_evidence_path,
            ),
          ]
        : []),
    ],
    sourceRoot,
    { allowEmpty: true },
  );
  if (evidence) artifacts.push({ role: "diagnostics", ref: evidence });
  const result = executionResult(plan, platform, execution.stages, artifacts);
  return publishRecord(
    plan,
    names.execution,
    result,
    path.join(workspace, `.buildchain/records/${platform.id}`),
  );
}
