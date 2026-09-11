import assert from "node:assert/strict";
import test from "node:test";
import { resolveRecoveryTransaction } from "../packages/core/release/recovery/transactions.js";

test("recovery resolves an exact publication version without scanning historical state refs", async () => {
  const transaction = {
    id: "transaction-exact",
    version: "4.0.1-alpha.18",
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    assert.doesNotMatch(url, /matching-refs/u);
    return new Response(JSON.stringify({
      type: "file",
      encoding: "base64",
      content: Buffer.from(JSON.stringify(transaction)).toString("base64"),
    }), { status: 200 });
  };

  const result = await resolveRecoveryTransaction({
    repoInfo: {
      owner: "kungfu-systems",
      repo: "buildchain",
    },
    apiUrl: "https://api.github.test",
    token: "test-token",
    fetchImpl,
    transactionId: transaction.id,
    publicationVersion: transaction.version,
  });

  assert.deepEqual(result, { version: transaction.version, transaction });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /contents\/state\.json\?ref=buildchain%2Frelease-state%2F4-0-1-alpha-18$/u);
});

test("recovery scans historical state refs only when the exact publication version is absent", async () => {
  const transaction = {
    id: "transaction-fallback",
    version: "4.0.1-alpha.18",
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("contents/state.json?ref=buildchain%2Frelease-state%2F4-0-1-alpha-19")) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (url.includes("git/matching-refs/heads/buildchain/release-state/")) {
      return new Response(JSON.stringify([{
        ref: "refs/heads/buildchain/release-state/4-0-1-alpha-18",
      }]), { status: 200 });
    }
    return new Response(JSON.stringify({
      type: "file",
      encoding: "base64",
      content: Buffer.from(JSON.stringify(transaction)).toString("base64"),
    }), { status: 200 });
  };

  const result = await resolveRecoveryTransaction({
    repoInfo: {
      owner: "kungfu-systems",
      repo: "buildchain",
    },
    apiUrl: "https://api.github.test",
    token: "test-token",
    fetchImpl,
    transactionId: transaction.id,
    publicationVersion: "4.0.1-alpha.19",
  });

  assert.deepEqual(result, { version: transaction.version, transaction });
  assert.equal(calls.length, 3);
  assert.match(calls[1], /git\/matching-refs\/heads\/buildchain\/release-state\/$/u);
});

test("recovery without a transaction id starts fresh instead of adopting the exact-version transaction", async () => {
  const fetchImpl = async () => {
    throw new Error("fresh recovery must not read durable transaction state");
  };

  const result = await resolveRecoveryTransaction({
    repoInfo: {
      owner: "kungfu-systems",
      repo: "buildchain",
    },
    apiUrl: "https://api.github.test",
    token: "test-token",
    fetchImpl,
    publicationVersion: "4.0.1",
  });

  assert.deepEqual(result, { version: "4.0.1", transaction: undefined });
});
