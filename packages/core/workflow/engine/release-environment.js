import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fail } from "./identity.js";
const TRUSTED_PUBLISHING_NPM_VERSION = "11.13.0";
export function prepareTrustedPublishingNpm() {
  if (
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    fail("trusted publishing requires GitHub Actions OIDC authority");
  const binDirectory = path.resolve(".buildchain/runtime/bin");
  const npmShim = path.join(binDirectory, "npm");
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(
    npmShim,
    `#!/bin/sh\nexec corepack pnpm@11.7.0 dlx npm@${TRUSTED_PUBLISHING_NPM_VERSION} "$@"\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(npmShim, 0o755);
  process.env.PATH = `${binDirectory}${path.delimiter}${process.env.PATH || ""}`;
}
export function prepareReleasePromotionConsumerDependencies(repository) {
  if (repository !== "kungfu-systems/buildchain") return;
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (
    manifest.packageManager !== "pnpm@11.7.0" ||
    !fs.existsSync("pnpm-lock.yaml")
  )
    fail("Buildchain release consumer dependency lock is unavailable");
  const consumerModules = path.resolve("node_modules"),
    runtimeModules = path.resolve(".buildchain/runtime/node_modules");
  if (!fs.existsSync(consumerModules) && fs.existsSync(runtimeModules))
    fs.symlinkSync(
      path.relative(path.dirname(consumerModules), runtimeModules),
      consumerModules,
      "dir",
    );
  if (!fs.existsSync("node_modules/@kungfu-tech/kfd/package.json"))
    execFileSync(
      "corepack",
      "pnpm@11.7.0 install --frozen-lockfile --ignore-scripts".split(" "),
      { stdio: ["ignore", 2, 2] },
    );
  if (fs.existsSync(runtimeModules)) {
    if (fs.realpathSync(consumerModules) !== fs.realpathSync(runtimeModules))
      fail("Buildchain release consumer runtime bridge conflicts");
    return;
  }
  fs.mkdirSync(path.dirname(runtimeModules), { recursive: true });
  fs.renameSync(consumerModules, runtimeModules);
  fs.symlinkSync(
    path.relative(path.dirname(consumerModules), runtimeModules),
    consumerModules,
    "dir",
  );
}
