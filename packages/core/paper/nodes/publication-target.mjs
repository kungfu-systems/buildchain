import { command, requireValue } from "../../runtime/action-process.mjs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
export function writeAuthorityConfig(env) {
  writeGitHubOutputs({
    "app-configured": Boolean(env.APP_CLIENT_ID && env.APP_PRIVATE_KEY),
  });
}
export function requireWriteAuthority(env) {
  requireValue(
    Boolean(env.APP_TOKEN || env.NARROW_TOKEN),
    "Paper release requires a GitHub App token or equivalent narrow generated-write token",
  );
}
export function resolvePaperTarget(env, execute = command) {
  const ref = env.INPUT_TARGET_REF || env.GITHUB_REF_NAME,
    sha = env.INPUT_TARGET_SHA || env.GITHUB_SHA;
  requireValue(
    /^(alpha|release)\/v\d+\/v\d+\.\d+$/.test(ref),
    "Paper release requires an exact alpha or release channel branch",
  );
  requireValue(
    /^[0-9a-f]{40}$/.test(sha),
    "Paper publication source SHA must be exact",
  );
  requireValue(
    execute("git", ["rev-parse", "HEAD"], { stdio: "pipe" }).trim() === sha,
    "Paper source checkout differs from the publication target",
  );
  writeGitHubOutputs({ ref, sha, channel: ref.split("/")[0] });
}
