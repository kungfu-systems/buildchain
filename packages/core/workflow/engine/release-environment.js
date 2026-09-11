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
  const binDirectory = path.resolve(".buildchain/tooling/trusted-publishing/bin");
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
export function prepareReleaseConsumerDependencies(directory = process.cwd(), execute = execFileSync) {
  const file = path.join(directory, "package.json");
  if (!fs.existsSync(file)) return;
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const manager = String(manifest.packageManager || "");
  if (!/^(?:npm|pnpm|yarn)@\d+\.\d+\.\d+(?:\+sha\d+\.[a-zA-Z0-9]+)?$/u.test(manager))
    fail("Release consumer dependencies require a pinned packageManager");
  const kind = manager.split("@")[0];
  const args = kind === "npm" ? ["ci", "--ignore-scripts"] : kind === "pnpm" ? ["install", "--frozen-lockfile", "--ignore-scripts"] : /^yarn@1\./u.test(manager) ? ["install", "--frozen-lockfile", "--ignore-scripts"] : ["install", "--immutable", "--mode=skip-builds"];
  execute("corepack", [manager, ...args], { cwd: directory, stdio: ["ignore", 2, 2] });
}
