import assert from "node:assert/strict";
import test from "node:test";
import { completePublicationDevelopment } from "../actions/v4-release-candidate-promote/publication-completion.js";

const request = {
  repository: "owner/repo",
  sourceSha: "a".repeat(40),
  token: "test-only",
  channel: "alpha",
  settlement: {
    productProviderResult: { publication: { releaseSha: "b".repeat(40) } },
    releaseReceipt: { receiptRoot: "sha256:" + "c".repeat(64) },
  },
  documents: { version: "4.0.2-alpha.36", tag: "v4.0.2-alpha.36" },
  sourceBinding: { protectedSource: { tree: "d".repeat(40) } },
  providerRequest: {
    publicationIntent: { sourceTimestamp: "2026-09-05T00:00:00Z" },
  },
};

test("publication becomes readable before any development wait and retains exact source authority", async () => {
  const events = [];
  await completePublicationDevelopment(request, {
    client: () => ({}),
    retain: async (args) => {
      assert.equal(args.candidateSha, request.sourceSha);
      events.push("published");
    },
    advance: async (args) => {
      assert.deepEqual(events, ["published"]);
      assert.equal(
        args.completedAlpha.publicationRoot,
        request.settlement.releaseReceipt.receiptRoot,
      );
      assert.equal(
        args.completedAlpha.releaseSha,
        request.settlement.productProviderResult.publication.releaseSha,
      );
      events.push("advanced");
      return { status: "verified" };
    },
    write: (_file, value) => {
      assert.equal(value.status, "verified");
      events.push("recorded");
    },
  });
  assert.deepEqual(events, ["published", "advanced", "recorded"]);
});

test("failed publication readback blocks development; failed development never removes publication", async () => {
  const events = [];
  await assert.rejects(
    completePublicationDevelopment(request, {
      client: () => ({}),
      retain: async () => {
        throw new Error("readback failed");
      },
      advance: async () => events.push("advanced"),
    }),
    /readback failed/u,
  );
  assert.deepEqual(events, []);
  await assert.rejects(
    completePublicationDevelopment(request, {
      client: () => ({}),
      retain: async () => events.push("published"),
      advance: async () => {
        throw new Error("review pending");
      },
      write: () => events.push("false completion"),
    }),
    /review pending/u,
  );
  assert.deepEqual(events, ["published"]);
});
