import assert from "node:assert/strict";
import test from "node:test";
import { ensureCloudFrontDirectoryIndexRewrite } from "../scripts/web-surface-cloudfront-rewrite.mjs";

const DESIRED_ARN = "arn:aws:cloudfront::123456789012:function/buildchain-directory-index";

function withFakeAws(scenario, run) {
  const state = { ...structuredClone(scenario), calls: [], getIndex: 0, updateIndex: 0 };
  function fakeAws(args, { allowFailure = false } = {}) {
    const operation = args.slice(0, 2).join(" ");
    state.calls.push(args);
    let response;
    if (operation === "cloudfront describe-function") {
      response = { data: { ETag: "function-development" } };
    } else if (operation === "cloudfront update-function") {
      response = { data: { ETag: "function-updated" } };
    } else if (operation === "cloudfront publish-function") {
      response = { data: { ETag: "function-published", FunctionSummary: { FunctionMetadata: { FunctionARN: state.desiredArn } } } };
    } else if (operation === "cloudfront get-distribution-config") {
      const current = state.getResponses[state.getIndex++];
      if (!current) {
        response = { status: 2, stderr: "unexpected get-distribution-config call" };
      } else {
        const items = current.viewerRequestArn
          ? [{ EventType: "viewer-request", FunctionARN: current.viewerRequestArn }]
          : [];
        response = { data: {
          ETag: current.etag,
          DistributionConfig: {
            CallerReference: "fixture",
            DefaultCacheBehavior: {
              TargetOriginId: "origin",
              FunctionAssociations: { Quantity: items.length, Items: items },
            },
          },
        } };
      }
    } else if (operation === "cloudfront update-distribution") {
      response = state.updateResponses[state.updateIndex++] || { status: 2, stderr: "unexpected update-distribution call" };
    } else {
      response = { status: 2, stderr: `unexpected aws operation: ${operation}` };
    }

    const status = response.status ?? 0;
    const stderr = response.stderr || "";
    const result = { ok: status === 0, status, stdout: status === 0 ? JSON.stringify(response.data || {}) : "", stderr };
    if (!result.ok && !allowFailure) {
      throw new Error(`aws ${args.join(" ")} failed with exit code ${status}${stderr ? `: ${stderr.trim()}` : ""}`);
    }
    return result;
  }
  return run(() => structuredClone(state), fakeAws);
}

function preconditionFailure() {
  return {
    status: 254,
    stderr: "An error occurred (PreconditionFailed) when calling the UpdateDistribution operation: stale If-Match ETag\n",
  };
}

test("CloudFront directory-index attachment retries a stale distribution ETag", () => {
  withFakeAws({
    desiredArn: DESIRED_ARN,
    getResponses: [{ etag: "distribution-1" }, { etag: "distribution-2" }],
    updateResponses: [preconditionFailure(), { data: { Distribution: { Id: "E-FIXTURE" } } }],
  }, (readState, runAwsCommand) => {
    const result = ensureCloudFrontDirectoryIndexRewrite({
      distributionId: "E-FIXTURE",
      functionName: "buildchain-directory-index",
      runAwsCommand,
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
  }, (readState, runAwsCommand) => {
    const result = ensureCloudFrontDirectoryIndexRewrite({
      distributionId: "E-FIXTURE",
      functionName: "buildchain-directory-index",
      runAwsCommand,
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
  }, (_readState, runAwsCommand) => {
    assert.throws(
      () => ensureCloudFrontDirectoryIndexRewrite({
        distributionId: "E-FIXTURE",
        functionName: "buildchain-directory-index",
        runAwsCommand,
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
  }, (readState, runAwsCommand) => {
    assert.throws(
      () => ensureCloudFrontDirectoryIndexRewrite({
        distributionId: "E-FIXTURE",
        functionName: "buildchain-directory-index",
        runAwsCommand,
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
  }, (readState, runAwsCommand) => {
    assert.throws(
      () => ensureCloudFrontDirectoryIndexRewrite({
        distributionId: "E-FIXTURE",
        functionName: "buildchain-directory-index",
        runAwsCommand,
      }),
      /still failed after 3 attempts.*PreconditionFailed/,
    );
    assert.equal(readState().getIndex, 3);
    assert.equal(readState().updateIndex, 3);
  });
});
