import path from "node:path";
import { ISOLATED_GIT_GLOBAL_CONFIG } from "./values.js";
export function githubAuthEnv(token = "") {
  if (!token) {
    return {};
  }
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
  };
}

export function isolatedGitFetchEnv(env = {}, targetPath) {
  const configuredCount = Number.parseInt(env.GIT_CONFIG_COUNT || "0", 10);
  const safeDirectoryIndex =
    Number.isInteger(configuredCount) && configuredCount >= 0
      ? configuredCount
      : 0;
  return {
    ...env,
    // Runner-global URL rewrites are shared mutable state. A concurrent job
    // may point the same repository URL at a different single-SHA bundle, so
    // network fetches must not consult the account-level Git config.
    GIT_CONFIG_GLOBAL: ISOLATED_GIT_GLOBAL_CONFIG,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(safeDirectoryIndex + 1),
    [`GIT_CONFIG_KEY_${safeDirectoryIndex}`]: "safe.directory",
    [`GIT_CONFIG_VALUE_${safeDirectoryIndex}`]: path.resolve(targetPath),
  };
}
