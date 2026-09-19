import test from "node:test";
import assert from "node:assert/strict";
import { pipelineNpmChannel } from "../packages/core/publication/npm/pipeline-channel.js";

test("historical npm channel readback has no writer and needs no credential for public packages", async () => {
  const calls = [];
  const provider = pipelineNpmChannel({
    environment: {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(
        url,
        "https://registry.npmjs.org/-/package/%40example%2Fproduct/dist-tags",
      );
      assert.equal(options.method, undefined);
      assert.deepEqual(options.headers, {});
      assert.equal(options.redirect, "error");
      return { ok: true, json: async () => ({ alpha: "1.0.0-alpha.1" }) };
    },
  });
  assert.equal(provider.apply, undefined);
  assert.deepEqual(
    await provider.observe({ name: "@example/product", tag: "alpha" }),
    {
      state: "present",
      version: "1.0.0-alpha.1",
    },
  );
  assert.equal(calls.length, 1);
});

test("npm channel rejects unknown provider failures without exposing response bodies", async () => {
  const provider = pipelineNpmChannel({
    environment: { NODE_AUTH_TOKEN: "secret-fixture" },
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ token: "must-not-appear" }),
    }),
  });
  await assert.rejects(
    provider.observe({
      name: "@example/product",
      tag: "alpha",
      version: "1.0.0-alpha.1",
    }),
    (error) =>
      error.message.includes("HTTP 403") &&
      !error.message.includes("secret") &&
      !error.message.includes("must-not-appear"),
  );
});

test("restricted npm channel readback requires and confines its read credential", async () => {
  const effect = {
    name: "@example/private",
    tag: "alpha",
    access: "restricted",
  };
  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests++;
    assert.equal(
      url,
      "https://registry.npmjs.org/-/package/%40example%2Fprivate/dist-tags",
    );
    assert.equal(options.headers.authorization, "Bearer read-fixture");
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => ({ alpha: "1.0.0-alpha.1" }) };
  };
  await assert.rejects(
    pipelineNpmChannel({ environment: {}, fetchImpl }).observe(effect),
    /read credential/,
  );
  assert.equal(requests, 0);
  assert.deepEqual(
    await pipelineNpmChannel({
      environment: { NODE_AUTH_TOKEN: "read-fixture" },
      fetchImpl,
    }).observe(effect),
    { state: "present", version: "1.0.0-alpha.1" },
  );
});
