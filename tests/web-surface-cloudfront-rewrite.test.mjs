import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  ensureCloudFrontDirectoryIndexRewrite,
  renderCloudFrontViewerRequestFunction,
} from "../scripts/web-surface-cloudfront-rewrite.mjs";

const DESIRED_ARN = "arn:aws:cloudfront::123456789012:function/buildchain-directory-index";

function withFakeAws(scenario, run) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-cloudfront-rewrite-test-"));
  const binDir = path.join(workspace, "bin");
  const statePath = path.join(workspace, "state.json");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({ ...scenario, calls: [], getIndex: 0, updateIndex: 0 }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(binDir, "aws"),
    `#!/usr/bin/env node
import fs from "node:fs";

const statePath = process.env.BUILDCHAIN_FAKE_AWS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const operation = args.slice(0, 2).join(" ");
state.calls.push(args);

function finish({ status = 0, data = {}, stderr = "" } = {}) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
  if (stderr) process.stderr.write(stderr);
  if (status === 0) process.stdout.write(JSON.stringify(data));
  process.exit(status);
}

if (operation === "cloudfront describe-function") {
  finish({ data: { ETag: "function-development" } });
}
if (operation === "cloudfront update-function") {
  finish({ data: { ETag: "function-updated" } });
}
if (operation === "cloudfront publish-function") {
  finish({ data: {
    ETag: "function-published",
    FunctionSummary: { FunctionMetadata: { FunctionARN: state.desiredArn } },
  } });
}
if (operation === "cloudfront get-distribution-config") {
  const response = state.getResponses[state.getIndex++];
  if (!response) finish({ status: 2, stderr: "unexpected get-distribution-config call" });
  const items = response.viewerRequestArn
    ? [{ EventType: "viewer-request", FunctionARN: response.viewerRequestArn }]
    : [];
  finish({ data: {
    ETag: response.etag,
    DistributionConfig: {
      CallerReference: "fixture",
      DefaultCacheBehavior: {
        TargetOriginId: "origin",
        FunctionAssociations: { Quantity: items.length, Items: items },
      },
    },
  } });
}
if (operation === "cloudfront update-distribution") {
  const response = state.updateResponses[state.updateIndex++];
  if (!response) finish({ status: 2, stderr: "unexpected update-distribution call" });
  finish(response);
}
finish({ status: 2, stderr: "unexpected aws operation: " + operation });
`,
    { mode: 0o755 },
  );

  const previousPath = process.env.PATH;
  const previousState = process.env.BUILDCHAIN_FAKE_AWS_STATE;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
  process.env.BUILDCHAIN_FAKE_AWS_STATE = statePath;
  try {
    return run(() => JSON.parse(fs.readFileSync(statePath, "utf8")));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.BUILDCHAIN_FAKE_AWS_STATE;
    else process.env.BUILDCHAIN_FAKE_AWS_STATE = previousState;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function preconditionFailure() {
  return {
    status: 254,
    stderr: "An error occurred (PreconditionFailed) when calling the UpdateDistribution operation: stale If-Match ETag\n",
  };
}

function runViewerRequest(code, uri) {
  const context = {
    event: { request: { uri, headers: {} } },
    result: null,
  };
  vm.runInNewContext(`${code}\nresult = handler(event);`, context);
  return context.result;
}

test("CloudFront viewer-request routing applies exact redirects before directory-index rewrites", () => {
  const code = renderCloudFrontViewerRequestFunction([
    { source: "/install.sh", target: "https://libkungfu.dev/install.sh", status: 307 },
  ]);
  const redirect = runViewerRequest(code, "/install.sh");
  assert.equal(redirect.statusCode, 307);
  assert.equal(redirect.statusDescription, "Temporary Redirect");
  assert.equal(redirect.headers.location.value, "https://libkungfu.dev/install.sh");
  assert.equal(redirect.headers["cache-control"].value, "no-store");

  assert.equal(runViewerRequest(code, "/docs/").uri, "/docs/index.html");
  assert.equal(runViewerRequest(code, "/install.sh/extra").uri, "/install.sh/extra");
});

test("CloudFront directory-index attachment retries a stale distribution ETag", () => {
  withFakeAws({
    desiredArn: DESIRED_ARN,
    getResponses: [{ etag: "distribution-1" }, { etag: "distribution-2" }],
    updateResponses: [preconditionFailure(), { data: { Distribution: { Id: "E-FIXTURE" } } }],
  }, (readState) => {
    const result = ensureCloudFrontDirectoryIndexRewrite({
      distributionId: "E-FIXTURE",
      functionName: "buildchain-directory-index",
    });
    assert.equal(result.functionArn, DESIRED_ARN);
    const updates = readState().calls.filter((args) => args.slice(0, 2).join(" ") === "cloudfront update-distribution");
    assert.deepEqual(updates.map((args) => args[args.indexOf("--if-match") + 1]), ["distribution-1", "distribution-2"]);
  });
});

test("CloudFront directory-index attachment accepts concurrent convergence after a stale ETag", () => {
  withFakeAws({
    desiredArn: DESIRED_ARN,
    getResponses: [
      { etag: "distribution-1" },
      { etag: "distribution-2", viewerRequestArn: DESIRED_ARN },
    ],
    updateResponses: [preconditionFailure()],
  }, (readState) => {
    const result = ensureCloudFrontDirectoryIndexRewrite({
      distributionId: "E-FIXTURE",
      functionName: "buildchain-directory-index",
    });
    assert.equal(result.nextViewerRequestFunction, DESIRED_ARN);
    assert.equal(readState().updateIndex, 1);
  });
});

test("CloudFront directory-index attachment rejects a conflicting concurrent viewer-request function", () => {
  withFakeAws({
    desiredArn: DESIRED_ARN,
    getResponses: [
      { etag: "distribution-1" },
      { etag: "distribution-2", viewerRequestArn: "arn:aws:cloudfront::123456789012:function/other" },
    ],
    updateResponses: [preconditionFailure()],
  }, () => {
    assert.throws(
      () => ensureCloudFrontDirectoryIndexRewrite({
        distributionId: "E-FIXTURE",
        functionName: "buildchain-directory-index",
      }),
      /already has a different viewer-request function/,
    );
  });
});

test("CloudFront directory-index attachment does not retry non-ETag failures", () => {
  withFakeAws({
    desiredArn: DESIRED_ARN,
    getResponses: [{ etag: "distribution-1" }],
    updateResponses: [{ status: 254, stderr: "An error occurred (AccessDenied) when calling UpdateDistribution\n" }],
  }, (readState) => {
    assert.throws(
      () => ensureCloudFrontDirectoryIndexRewrite({
        distributionId: "E-FIXTURE",
        functionName: "buildchain-directory-index",
      }),
      /AccessDenied/,
    );
    assert.equal(readState().getIndex, 1);
    assert.equal(readState().updateIndex, 1);
  });
});

test("CloudFront directory-index attachment bounds repeated stale ETag retries", () => {
  withFakeAws({
    desiredArn: DESIRED_ARN,
    getResponses: [
      { etag: "distribution-1" },
      { etag: "distribution-2" },
      { etag: "distribution-3" },
    ],
    updateResponses: [preconditionFailure(), preconditionFailure(), preconditionFailure()],
  }, (readState) => {
    assert.throws(
      () => ensureCloudFrontDirectoryIndexRewrite({
        distributionId: "E-FIXTURE",
        functionName: "buildchain-directory-index",
      }),
      /still failed after 3 attempts.*PreconditionFailed/,
    );
    assert.equal(readState().getIndex, 3);
    assert.equal(readState().updateIndex, 3);
  });
});
