import { spawnSync } from "node:child_process";

export function gitTransferRequest({
  host,
  remotePath,
  repository,
  ref,
  force = false,
  credential = "",
  user = "",
}) {
  if (!host || !/^[a-z0-9.-]+(?::[0-9]+)?$/iu.test(host))
    throw new Error("remote-host must be a DNS host with an optional port");
  if (
    !repository ||
    !remotePath ||
    [remotePath, repository].some(
      (value) =>
        /[\s?#\\]/u.test(value) ||
        value.split("/").some((part) => !part || part === "." || part === ".."),
    )
  )
    throw new Error(
      "remote repository path must have literal nonempty segments",
    );
  if (!ref || ref.startsWith("-") || /[\s:~^?*\[\\]/u.test(ref))
    throw new Error("source ref must be a literal branch or tag name");
  const url = `https://${host}/${remotePath}/${repository}`;
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  };
  if (credential) {
    let parsed;
    try {
      parsed = new URL(credential);
    } catch {
      throw new Error("REMOTE_CREDENTIAL must be an HTTPS credential URL");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.host !== host ||
      !parsed.username ||
      !parsed.password
    )
      throw new Error(
        "remote credential must bind the exact HTTPS host and user",
      );
    const username = user || decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    if (/[\r\n]/u.test(username + password))
      throw new Error("remote credentials must not contain newlines");
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_1 = `http.https://${host}/.extraheader`;
    env.GIT_CONFIG_VALUE_1 = `Authorization: Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }
  return {
    url,
    env,
    commands: [
      ["fetch", "--", url],
      ["push", ...(force ? ["--force"] : []), "--", url, ref],
    ],
  };
}

export function transferGit(
  request,
  { run = spawnSync, env = process.env } = {},
) {
  for (const args of request.commands) {
    const result = run("git", args, {
      env: { ...env, ...request.env },
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      shell: false,
    });
    // A provider may reflect credentials. Report only command identity and status.
    if (result.error || result.status !== 0)
      throw new Error(
        `remote git ${args[0]} failed with status ${result.status ?? "unavailable"}`,
      );
  }
}
