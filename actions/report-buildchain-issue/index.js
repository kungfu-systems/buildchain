import * as core from "@actions/core";
import {
  readOptionalIssueBodyFile,
  reportBuildchainIssue,
  reportWorkflowFrictionIssue,
} from "../../packages/core/issue-reporting.js";

function input(name) {
  return core.getInput(name);
}

function boolInput(name) {
  return core.getBooleanInput(name);
}

function setResultOutputs(result) {
  core.setOutput("ok", String(result.ok === true));
  core.setOutput("action", result.action || "");
  core.setOutput("issue-number", result.issueNumber ? String(result.issueNumber) : "");
  core.setOutput("issue-url", result.issueUrl || "");
  core.setOutput("created", String(result.created === true));
  core.setOutput("commented", String(result.commented === true));
  core.setOutput("fingerprint", result.fingerprint || "");
}

async function main() {
  const bodyFile = input("body-file");
  const bodyParts = [input("body"), readOptionalIssueBodyFile(bodyFile)].filter(Boolean);
  const common = {
    token: input("token"),
    targetRepository: input("target-repository"),
    title: input("title"),
    summary: input("summary"),
    fingerprint: input("fingerprint"),
    labels: input("labels"),
    mode: input("mode") || "create-or-comment",
    dryRun: boolInput("dry-run"),
    maxBodyBytes: Number(input("max-body-bytes") || 60000),
    commentCooldownHours: Number(input("comment-cooldown-hours") || 0),
  };
  const reportKind = input("report-kind") || "consumer";
  const result = reportKind === "workflow-friction"
    ? await reportWorkflowFrictionIssue({
        ...common,
        repository: input("repository") || input("consumer-repository"),
        workflow: input("workflow"),
        runId: input("run-id"),
        runUrl: input("run-url"),
        runAttempt: input("run-attempt"),
        pullRequest: input("pull-request"),
        channel: input("channel"),
        releaseIntent: input("release-intent"),
        version: input("version"),
        sourceRef: input("source-ref") || input("consumer-ref"),
        sourceSha: input("source-sha") || input("consumer-sha"),
        sourceTreeHash: input("source-tree-hash"),
        frictionClass: input("friction-class") || input("failure-code"),
        diagnosis: input("diagnosis"),
        nextAction: input("next-action"),
        body: bodyParts.join("\n\n"),
      })
    : await reportBuildchainIssue({
        ...common,
        failureCode: input("failure-code"),
        consumerRepository: input("consumer-repository"),
        consumerRef: input("consumer-ref"),
        consumerSha: input("consumer-sha"),
        workflow: input("workflow"),
        job: input("job"),
        runId: input("run-id"),
        runUrl: input("run-url"),
        buildchainRef: input("buildchain-ref"),
        buildchainVersion: input("buildchain-version"),
        artifactUrl: input("artifact-url"),
        passportUrl: input("passport-url"),
        passportPath: input("passport-path"),
        diagnosticsUrl: input("diagnostics-url"),
        diagnosticsPath: input("diagnostics-path"),
        body: bodyParts.join("\n\n"),
      });
  setResultOutputs(result);
  await core.summary
    .addHeading("Buildchain issue report")
    .addTable([
      [
        { data: "Field", header: true },
        { data: "Value", header: true },
      ],
      ["Action", result.action || ""],
      ["Issue", result.issueUrl || "(none)"],
      ["Fingerprint", result.fingerprint || ""],
    ])
    .write();
}

main().catch((error) => {
  setResultOutputs({
    ok: false,
    action: "failed",
    issueNumber: "",
    issueUrl: "",
    created: false,
    commented: false,
    fingerprint: "",
  });
  if (boolInput("fail-on-error")) {
    core.setFailed(error.message);
    return;
  }
  core.warning(`Buildchain issue reporting failed: ${error.message}`);
});
