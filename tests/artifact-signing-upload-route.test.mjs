import assert from "node:assert/strict";
import test from "node:test";

import { resolveArtifactSigningUploadRoute } from "../scripts/resolve-artifact-signing-upload-route.mjs";

test("artifact signing upload route preserves the runner proxy bypass by default", () => {
  assert.deepEqual(
    resolveArtifactSigningUploadRoute({
      noProxy: "localhost,127.0.0.1",
      lowerNoProxy: "localhost",
    }),
    {
      noProxy: "localhost,127.0.0.1",
      overrideApplied: false,
    },
  );
});

test("artifact signing upload route scopes an explicit bypass to both proxy variable forms", () => {
  assert.deepEqual(
    resolveArtifactSigningUploadRoute({
      requestedNoProxy: ".blob.core.windows.net",
      noProxy: "localhost",
      lowerNoProxy: "127.0.0.1",
    }),
    {
      noProxy: ".blob.core.windows.net",
      overrideApplied: true,
    },
  );
});

test("artifact signing upload route rejects multiline workflow input", () => {
  assert.throws(
    () => resolveArtifactSigningUploadRoute({ requestedNoProxy: "localhost\nexample.invalid" }),
    /single-line NO_PROXY value/,
  );
});
