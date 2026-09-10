import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mediaContainerArguments } from "../packages/core/build/demo/media-qualification.js";

test("media rendering and inspection retain immutable image and container isolation", () => {
  const env = {
    workspace: path.join(os.tmpdir(), "buildchain fixture"),
    fixture: "auditable-demo-web-delivery-v1",
    rendererImage: `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${"a".repeat(64)}`,
  };
  for (const operation of ["render", "inspect"]) {
    const args = mediaContainerArguments(env, operation);
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.ok(args.includes("--read-only"));
    assert.match(args[args.indexOf("--tmpfs") + 1], /noexec,nosuid/u);
    assert.ok(args.includes(env.rendererImage));
    const volumes = args.filter((_, index) => args[index - 1] === "--volume");
    assert.ok(volumes.some((value) => value.endsWith(":ro")));
    assert.ok(volumes.every((value) => value.startsWith(env.workspace)));
  }
  assert.throws(
    () =>
      mediaContainerArguments(
        {
          ...env,
          rendererImage:
            "ghcr.io/kungfu-systems/build-images/demo-renderer:latest",
        },
        "render",
      ),
    /immutable/u,
  );
  assert.throws(() =>
    mediaContainerArguments({ ...env, fixture: "../secret" }, "render"),
  );
});
