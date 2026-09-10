import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("delivery CLI forwards explicit provider connection and cannot read without a credential", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-cli-connection-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
    });
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"message":"Not Found"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const entry = fileURLToPath(
    new URL("../bin/buildchain.mjs", import.meta.url),
  );
  const run = (token) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          entry,
          "dev",
          "warrant",
          "observe",
          "--repository",
          "fixture/repository",
          "--branch",
          "dev/v4/v4.1",
          "--json",
          "--output",
          path.join(directory, "result.json"),
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            GITHUB_TOKEN: token,
            GH_TOKEN: "",
            GITHUB_API_URL: apiUrl,
          },
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const admitted = await run("fixture-scoped-token");
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.match(
    calls[0].path,
    /^\/repos\/fixture\/repository\/git\/ref\/heads\//,
  );
  assert.equal(calls[0].authorization, "Bearer fixture-scoped-token");
  assert.equal(JSON.parse(admitted.stdout).observation.activeWarrant, null);
  assert.equal(admitted.stdout.includes("fixture-scoped-token"), false);
  const rejected = await run("");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /GITHUB_TOKEN is required/);
  assert.equal(calls.length, 1);
});
