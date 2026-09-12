import test from "node:test";
import assert from "node:assert/strict";
import { pipelineNpmChannel } from "../packages/core/publication/npm/pipeline-channel.js";

test("npm channel exchanges hosted identity for the exact package and never forwards provider tokens to a consumer host", async () => {
  const calls = [];
  let version = null;
  const effect = {
    name: "@example/product",
    tag: "alpha",
    version: "1.0.0-alpha.1",
  };
  const provider = pipelineNpmChannel({
    environment: {
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://pipelines.actions.githubusercontent.com/token?api-version=2",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "hosted-request-fixture",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      let body;
      if (url.startsWith("https://pipelines.actions.githubusercontent.com/")) {
        assert.equal(
          new URL(url).searchParams.get("audience"),
          "npm:registry.npmjs.org",
        );
        body = { value: "identity-fixture" };
      } else if (url.includes("/oidc/token/exchange/")) {
        assert.ok(url.endsWith("%40example%2Fproduct"));
        assert.equal(options.headers.authorization, "Bearer identity-fixture");
        body = { token: "package-fixture" };
      } else if (options.method === "PUT") {
        assert.equal(options.headers.authorization, "Bearer package-fixture");
        version = JSON.parse(options.body);
        body = { ok: true };
      } else body = version ? { alpha: version } : {};
      return { ok: true, json: async () => body };
    },
  });
  assert.deepEqual(await provider.observe(effect), {
    state: "absent",
    version: null,
  });
  await provider.apply(effect);
  assert.deepEqual(await provider.observe(effect), {
    state: "present",
    version: effect.version,
  });
  assert.ok(calls.every(({ options }) => options.redirect === "error"));
  assert.equal(
    calls.filter(({ options }) => options.method === "PUT").length,
    1,
  );
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
    provider.apply({
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
